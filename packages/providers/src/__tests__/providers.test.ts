import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiAgentBackend } from "../backends/api.js";
import { buildCliInvocation, extractCliText } from "../backends/cli.js";
import { buildGrokAcpArguments, createGrokAcpToolTracker, effectiveGrokToolName, publishGrokAcpUpdate } from "../backends/grok-acp.js";
import { exampleModelConfig, validateModelConfig } from "../routing/config.js";
import { AgentPool } from "../routing/pool.js";
import type { AgentCall } from "../runtime/backend.js";
import { ProviderConversationStore } from "../runtime/conversations.js";
import { controlMcpServer, reviewDecisionFromTool, safetyDecisionFromTool } from "../tools/control-tools.js";
import { buildGrokMcpConfig, discoverMcpServers, grokPermissionRules, McpToolSession, validateMcpServers } from "../tools/mcp.js";
import { builtinPermissionCatalog, evaluatePermission, mcpAnnotationDecision, mcpPermissionAction } from "../tools/permissions.js";

const roots: string[] = [];
afterEach(async () =>
  (vi.unstubAllGlobals(), Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )),
);

describe("image transports", () => {
  const call: AgentCall = {
    cwd: "/workspace",
    systemPrompt: "system",
    prompt: "inspect",
    role: "generator",
    images: [{ id: "image_1", name: "screen.png", mediaType: "image/png", size: 8, filePath: "/managed/session/screen.image" }],
  };

  it("uses native Codex images and a restricted Claude attachment directory", () => {
    const codex = buildCliInvocation("codex", call, []);
    expect(codex.args).toContain("--image");
    expect(codex.args).toContain("--json");
    expect(codex.args).toContain("/managed/session/screen.image");
    const claude = buildCliInvocation("claude", call, []);
    expect(claude.args).toEqual(expect.arrayContaining(["--add-dir", "/managed/session"]));
    expect(claude.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
    expect(claude.input).toContain("screen.png: /managed/session/screen.image");
    expect(buildGrokAcpArguments(call, [])).toEqual(expect.arrayContaining(["agent", "stdio"]));
  });

  it.each(["anthropic", "openai-compatible"] as const)("builds %s visual content blocks", async (protocol) => {
    const root = path.resolve(".tmp/tests", `api-images-${protocol}-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const filePath = path.join(root, "screen.image"); await writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let requestBody = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(protocol === "anthropic" ? JSON.stringify({ content: [{ type: "text", text: "ok" }] }) : JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.RUNHARNESS_TEST_KEY = "test";
    try {
      const backend = new ApiAgentBackend("vision", { type: "api", protocol, apiKeyEnv: "RUNHARNESS_TEST_KEY", baseUrl: "https://example.test" });
      await backend.complete({ ...call, model: "vision-model", images: [{ ...call.images![0]!, filePath }] });
    } finally { delete process.env.RUNHARNESS_TEST_KEY; }
    const parsed = JSON.parse(requestBody) as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(parsed.messages)).toContain(protocol === "anthropic" ? '"type":"image"' : '"type":"image_url"');
    expect(requestBody).toContain(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"));
  });
});

describe("two-layer permission policy", () => {
  it("keeps the displayed built-in catalog aligned with enforced examples", () => {
    const policy = { workspace: { placement: "in_place" as const, access: "read_write" as const, materializeIgnored: [] }, network: "allow_declared" as const, approvalMode: "dangerous_only" as const, customRules: [] };
    const decisions = [
      evaluatePermission(policy, { kind: "command", summary: "remove", command: "rm -rf build" }).decision,
      evaluatePermission(policy, { kind: "command", summary: "secret", command: "security find-generic-password" }).decision,
      evaluatePermission(policy, { kind: "file", summary: "ssh", path: "/home/user/.ssh/config" }).decision,
      evaluatePermission(policy, { kind: "network", summary: "external", origin: "https://api.example.com" }).decision,
      mcpAnnotationDecision(mcpPermissionAction("mcp__browser__click", {}, { openWorldHint: true }), { openWorldHint: true })?.decision,
    ];
    expect(builtinPermissionCatalog.map((entry) => entry.id)).toEqual(["destructive_changes", "credential_access", "external_network", "mcp_side_effects", "reversible_development"]);
    expect(decisions).toEqual(["ask", "ask", "ask", "ask", "ask"]);
    expect(evaluatePermission(policy, { kind: "command", summary: "test", command: "pnpm test" }).decision).toBe("allow");
  });

  it("keeps allow-all explicit and defaults dangerous actions to approval", () => {
    const destructive = { kind: "git" as const, summary: "push main", command: "git push origin main" };
    expect(evaluatePermission({ workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_all", approvalMode: "allow_all", customRules: [] }, destructive).decision).toBe("allow");
    expect(evaluatePermission({ workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "dangerous_only", customRules: [] }, destructive).decision).toBe("ask");
  });

  it("applies narrow custom rules before the preset default", () => {
    const policy = { workspace: { placement: "in_place" as const, access: "read_write" as const, materializeIgnored: [] }, network: "allow_declared" as const, approvalMode: "allow_all" as const, customRules: [{ id: "deny-prod", scope: "origin" as const, pattern: "https://prod.example.com", decision: "deny" as const }] };
    expect(evaluatePermission(policy, { kind: "network", summary: "prod", origin: "https://prod.example.com" }).decision).toBe("deny");
  });

  it("uses the most restrictive matching project rule", () => {
    const policy = { workspace: { placement: "in_place" as const, access: "read_write" as const, materializeIgnored: [] }, network: "allow_declared" as const, approvalMode: "dangerous_only" as const, customRules: [
      { id: "allow-git", scope: "command" as const, pattern: "git *", decision: "allow" as const },
      { id: "deny-push", scope: "command" as const, pattern: "git push *", decision: "deny" as const },
    ] };
    expect(evaluatePermission(policy, { kind: "git", summary: "push", command: "git push origin main" })).toMatchObject({ decision: "deny", ruleId: "deny-push" });
  });

  it("allows localhost navigation but asks for external browser mutation", () => {
    const local = mcpPermissionAction("mcp__playwright__browser_navigate", { url: "http://127.0.0.1:8888" }, { openWorldHint: true });
    expect(mcpAnnotationDecision(local, { openWorldHint: true })).toBeUndefined();
    const click = mcpPermissionAction("mcp__playwright__browser_click", { selector: "#publish" }, { openWorldHint: true });
    expect(mcpAnnotationDecision(click, { openWorldHint: true })?.decision).toBe("ask");
  });
});

describe("project MCP transports", () => {
  const call: AgentCall = {
    cwd: "/workspace",
    systemPrompt: "system",
    prompt: "inspect",
    role: "generator",
    mcpServers: {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], enabled: true, disabledTools: ["browser_run_code"] },
    },
  };

  it("enables the built-in Playwright server with dangerous tools disabled by default", () => {
    expect(exampleModelConfig.mcpServers?.playwright).toMatchObject({
      enabled: true,
      disabledTools: ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"],
    });
  });

  it("injects annotated MCP configuration without wildcard grants", () => {
    const codex = buildCliInvocation("codex", call, []);
    expect(codex.args).toEqual(expect.arrayContaining(["-c", expect.stringContaining('"playwright"=')]));
    expect(codex.args).not.toContain("--ignore-user-config");
    expect(codex.args.join(" ")).toContain("@playwright/mcp@latest");
    expect(codex.args.join(" ")).toContain('"default_tools_approval_mode"="auto"');
    const claude = buildCliInvocation("claude", call, []);
    expect(claude.args).toEqual(expect.arrayContaining(["--mcp-config", "--strict-mcp-config"]));
    expect(claude.args).not.toContain("--allowedTools");
    expect(claude.args).toEqual(expect.arrayContaining(["--disallowedTools", "mcp__playwright__browser_run_code"]));
    const config = JSON.parse(claude.args[claude.args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers)).toEqual(["playwright"]);
    const grok = buildGrokAcpArguments(call, []);
    expect(grok).toEqual(expect.arrayContaining(["--cwd", "/workspace", "agent", "stdio"]));
  });

  it("keeps provider approval active and maps exact MCP deny rules", () => {
    const restricted: AgentCall = { ...call, options: { workspaceMode: "write", executionPolicy: { workspace: { placement: "isolated", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "allow_all", customRules: [{ id: "deny-evaluate", scope: "mcp_tool", pattern: "playwright/browser_evaluate", decision: "deny" }] } } };
    const codex = buildCliInvocation("codex", restricted, []);
    expect(codex.args.join(" ")).toContain('approval_policy="on-request"');
    expect(codex.args.join(" ")).toContain('"disabled_tools"=["browser_run_code","browser_evaluate"]');
    expect(codex.input).toContain('DENY mcp_tool "playwright/browser_evaluate"');
  });

  it("rejects silently ignored MCP options", () => {
    expect(() => validateMcpServers({ playwright: { command: "npx", approval: "always" } as never })).toThrow("unsupported option 'approval'");
  });

  it("discovers tools through the RunHarness MCP client", async () => {
    const code = `import {Server} from '@modelcontextprotocol/sdk/server/index.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';const server=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'browser_open',description:'Open a page',inputSchema:{type:'object'}}]}));await server.connect(new StdioServerTransport());`;
    const [status] = await discoverMcpServers({ fixture: { command: process.execPath, args: ["--input-type=module", "-e", code], disabledTools: ["missing_tool"] } }, path.resolve("packages/providers"));
    expect(status).toMatchObject({ name: "fixture", enabled: true, available: true });
    expect(status?.tools).toEqual([{ name: "browser_open", description: "Open a page" }]);
    expect(status?.unknownDisabledTools).toEqual(["missing_tool"]);
  });

  it("executes MCP tools for API backends and emits tool activity", async () => {
    const code = `import {Server} from '@modelcontextprotocol/sdk/server/index.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';const server=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'browser_snapshot',description:'Read the page',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}));server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'snapshot ready'}]}));await server.connect(new StdioServerTransport());`;
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(bodies.length === 1
        ? JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp__fixture__browser_snapshot", arguments: '{}' } }] } }] })
        : JSON.stringify({ choices: [{ message: { content: "browser verified" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    process.env.RUNHARNESS_TEST_KEY = "test";
    const activity: string[] = [];
    try {
      const backend = new ApiAgentBackend("api", { type: "api", protocol: "openai-compatible", apiKeyEnv: "RUNHARNESS_TEST_KEY", baseUrl: "https://example.test" });
      const response = await backend.complete({ cwd: path.resolve("packages/providers"), systemPrompt: "system", prompt: "check", role: "evaluator", model: "test", mcpServers: { fixture: { command: process.execPath, args: ["--input-type=module", "-e", code] } }, onActivity: (item) => { activity.push(item.kind); if (item.kind === "tool_call") expect(item.execution).toEqual({ owner: "runharness", placement: "host", runtimeId: "project-mcp", controlled: true }); } });
      expect(response.text).toBe("browser verified");
    } finally { delete process.env.RUNHARNESS_TEST_KEY; }
    expect(bodies[0]).toContain("mcp__fixture__browser_snapshot");
    expect(bodies[1]).toContain("snapshot ready");
    expect(activity).toEqual(["tool_call", "tool_result", "message"]);
  });

  it("rejects destructive, open-world, and unannotated API tools before server execution", async () => {
    const root = path.resolve(".tmp/tests", `mcp-approval-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const marker = path.join(root, "calls.log");
    const code = `import {appendFileSync} from 'node:fs';import {Server} from '@modelcontextprotocol/sdk/server/index.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';const server=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'snapshot',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'destructive',inputSchema:{type:'object'},annotations:{readOnlyHint:true,destructiveHint:true}},{name:'open_world',inputSchema:{type:'object'},annotations:{readOnlyHint:true,openWorldHint:true}},{name:'unknown',inputSchema:{type:'object'}}]}));server.setRequestHandler(CallToolRequestSchema,async(request)=>{appendFileSync(${JSON.stringify(marker)},request.params.name+'\\n');return {content:[{type:'text',text:'called '+request.params.name}]};});await server.connect(new StdioServerTransport());`;
    const session = await McpToolSession.open({ fixture: { command: process.execPath, args: ["--input-type=module", "-e", code] } }, path.resolve("packages/providers"));
    try {
      await expect(session.call("mcp__fixture__snapshot", {})).resolves.toMatchObject({ output: "called snapshot" });
      for (const name of ["destructive", "open_world", "unknown"]) {
        await expect(session.call(`mcp__fixture__${name}`, {})).rejects.toThrow("requires approval");
      }
    } finally { await session.close(); }
    expect(await readFile(marker, "utf8")).toBe("snapshot\n");
  });

  it("emits a failed tool result when a non-interactive API call is denied", async () => {
    const code = `import {Server} from '@modelcontextprotocol/sdk/server/index.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';const server=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'browser_click',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]}));await server.connect(new StdioServerTransport());`;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp__fixture__browser_click", arguments: '{}' } }] } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    process.env.RUNHARNESS_TEST_KEY = "test";
    const activity: Array<{ kind: string; success?: boolean }> = [];
    try {
      const backend = new ApiAgentBackend("api", { type: "api", protocol: "openai-compatible", apiKeyEnv: "RUNHARNESS_TEST_KEY", baseUrl: "https://example.test" });
      await expect(backend.complete({ cwd: path.resolve("packages/providers"), systemPrompt: "system", prompt: "check", role: "evaluator", model: "test", mcpServers: { fixture: { command: process.execPath, args: ["--input-type=module", "-e", code] } }, onActivity: (item) => { activity.push({ kind: item.kind, ...(item.success !== undefined ? { success: item.success } : {}) }); } })).rejects.toThrow("requires approval");
    } finally { delete process.env.RUNHARNESS_TEST_KEY; }
    expect(activity).toEqual([{ kind: "tool_call" }, { kind: "tool_result", success: false }]);
  });
});

describe("project acceptance config", () => {
  it("accepts explicit checks and rejects duplicate names", () => {
    const configured = { ...exampleModelConfig, acceptance: [{ kind: "command" as const, name: "tests", runtime: "local-command", command: "make test", required: true }] };
    expect(() => validateModelConfig(configured)).not.toThrow();
    expect(() => validateModelConfig({ ...configured, acceptance: [...configured.acceptance, configured.acceptance[0]] })).toThrow("unique name");
  });
});

describe("cancellable processes", () => {
  it("terminates the process tree when its AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    const task = import("../runtime/process.js").then(({ runProcess }) => runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
  });

  it.skipIf(process.platform === "win32")("cleans up descendants left after the process leader exits", async () => {
    const { runProcess } = await import("../runtime/process.js");
    let workerPid = 0;
    await runProcess(process.execPath, ["-e", `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);`], {
      cwd: process.cwd(),
      onStdoutLine: (line) => { workerPid = Number(line); },
    });
    expect(workerPid).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 20 && processExists(workerPid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(processExists(workerPid)).toBe(false);
  });
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

describe("Grok CLI transport", () => {
  it("uses ACP stdio and maps explicit boundaries into native Grok configuration", () => {
    const call: AgentCall = { cwd: "/workspace", systemPrompt: "system", prompt: "inspect", role: "generator", model: "grok-4.5", options: { workspaceMode: "write" }, mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"], disabledTools: ["browser_run_code"] } } };
    const invocation = buildGrokAcpArguments(call, ["--debug"]);
    expect(invocation).toEqual(["--cwd", "/workspace", "--no-subagents", "--debug", "agent", "--model", "grok-4.5", "stdio"]);
    const readOnly = buildGrokAcpArguments({ ...call, options: { workspaceMode: "read" } }, []);
    expect(readOnly).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    const rules = grokPermissionRules([
      { id: "ask-release", scope: "command", pattern: "pnpm publish", decision: "ask" },
      { id: "deny-secret", scope: "path", pattern: "**/.env", decision: "deny" },
      { id: "allow-status", scope: "command", pattern: "git status", decision: "allow" },
    ]);
    expect(rules).toEqual({ ask: ["Bash(pnpm publish)"], deny: ["Read(**/.env)", "Edit(**/.env)"] });
    const config = buildGrokMcpConfig(call.mcpServers, "/workspace", { workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "dangerous_only", customRules: [{ id: "ask-release", scope: "command", pattern: "pnpm publish", decision: "ask" }] });
    expect(config).toContain("[permission]");
    expect(config).toContain('ask = ["Bash(pnpm publish)"]');
    // Partial JSONL frames must not surface protocol noise as agent text.
    expect(extractCliText("codex", '{"type":"item.started","item":{"type":"command_execution","id":"1"}}\n')).toBe("");
    expect(extractCliText("claude", '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n')).toBe("ok");
    expect(extractCliText("claude", '{"type":"content_block_delta","delta":{"type":"text_delta"}}\n')).toBe("");
  });

  it("uses unattended native risk review without weakening explicit workspace boundaries", () => {
    const dangerousOnly: AgentCall = {
      cwd: "/workspace",
      systemPrompt: "system",
      prompt: "inspect",
      role: "generator",
      options: {
        workspaceMode: "write",
        executionPolicy: {
          workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] },
          network: "allow_declared",
          approvalMode: "dangerous_only",
          customRules: [],
        },
      },
    };
    expect(buildCliInvocation("claude", dangerousOnly, []).args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(buildCliInvocation("codex", dangerousOnly, []).args).toEqual(expect.arrayContaining([
      "-c", 'approval_policy="on-request"',
      "-c", 'approvals_reviewer="auto_review"',
    ]));

    const readOnly = { ...dangerousOnly, options: { ...dangerousOnly.options, workspaceMode: "read" as const } };
    expect(buildCliInvocation("claude", readOnly, []).args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk"]));
    expect(buildCliInvocation("codex", readOnly, []).args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "-c", 'approval_policy="never"']));
    expect(buildCliInvocation("codex", readOnly, []).args).not.toContain('approvals_reviewer="auto_review"');
  });

  it("exposes lifecycle decisions as read-only tools instead of response schemas", async () => {
    const status = await discoverMcpServers({ runharness_control: controlMcpServer("review") }, process.cwd());
    expect(status[0]).toMatchObject({ available: true });
    expect(status[0]?.tools.map((tool) => tool.name)).toEqual(["review_accept", "review_request_changes", "review_unavailable"]);
    const safety = await discoverMcpServers({ runharness_control: controlMcpServer("safety") }, process.cwd());
    expect(safety[0]?.tools.map((tool) => tool.name)).toEqual(["safety_allow", "safety_ask", "safety_deny"]);
    expect(reviewDecisionFromTool("mcp__runharness_control__review_request_changes")).toBe("request_changes");
    expect(reviewDecisionFromTool("runharness_control.review_accept")).toBe("accept");
    expect(safetyDecisionFromTool("runharness_control__safety_deny")).toBe("deny");
  });

  it("unwraps concise ACP meta calls into canonical MCP tool activity", async () => {
    const activity: Array<{ kind: string; tool?: string; success?: boolean }> = [];
    const call: AgentCall = {
      cwd: "/workspace",
      systemPrompt: "system",
      prompt: "review",
      role: "evaluator",
      onActivity: (item) => { activity.push({ kind: item.kind, ...(item.tool ? { tool: item.tool } : {}), ...(item.success !== undefined ? { success: item.success } : {}) }); },
    };
    const tools = createGrokAcpToolTracker();
    await publishGrokAcpUpdate(call, {
      sessionUpdate: "tool_call",
      toolCallId: "review-1",
      title: "use_tool",
      kind: "other",
      status: "in_progress",
      content: [],
      rawInput: { tool_name: "runharness_control__review_accept", tool_input: {} },
    }, tools);
    await publishGrokAcpUpdate(call, {
      sessionUpdate: "tool_call_update",
      toolCallId: "review-1",
      status: "completed",
      rawOutput: { type: "MCP", tool_name: "review_accept", server_name: "runharness_control", output: { OkayOutput: "recorded" } },
    }, tools);
    await publishGrokAcpUpdate(call, {
      sessionUpdate: "tool_call_update",
      toolCallId: "review-1",
      status: "completed",
      rawOutput: { type: "MCP", tool_name: "review_accept", server_name: "runharness_control", output: { OkayOutput: "recorded" } },
    }, tools);
    expect(activity).toEqual([
      { kind: "tool_call", tool: "runharness_control__review_accept" },
      { kind: "tool_result", tool: "runharness_control__review_accept", success: true },
    ]);
  });

  it("reorders an ACP result that arrives before its base tool call", async () => {
    const activity: string[] = [];
    const call: AgentCall = { cwd: "/workspace", systemPrompt: "system", prompt: "review", role: "evaluator", onActivity: (item) => { activity.push(`${item.kind}:${item.tool}`); } };
    const tools = createGrokAcpToolTracker();
    await publishGrokAcpUpdate(call, {
      sessionUpdate: "tool_call_update",
      toolCallId: "review-early",
      status: "completed",
      rawOutput: { type: "MCP", tool_name: "review_accept", server_name: "runharness_control" },
    }, tools);
    expect(activity).toEqual([]);
    await publishGrokAcpUpdate(call, {
      sessionUpdate: "tool_call",
      toolCallId: "review-early",
      title: "use_tool",
      kind: "other",
      status: "in_progress",
      content: [],
      rawInput: { tool_name: "runharness_control__review_accept", tool_input: {} },
    }, tools);
    expect(activity).toEqual([
      "tool_call:runharness_control__review_accept",
      "tool_result:runharness_control__review_accept",
    ]);
  });

  it("normalizes Safety meta calls while leaving ordinary tools unchanged", () => {
    expect(effectiveGrokToolName({ title: "use_tool", rawInput: { tool_name: "runharness_control__safety_allow", tool_input: {} } })).toBe("runharness_control__safety_allow");
    expect(effectiveGrokToolName({ title: "call_connected_tool", rawInput: { server_name: "runharness_control", tool_name: "safety_deny", tool_input: {} } })).toBe("runharness_control__safety_deny");
    expect(effectiveGrokToolName({ title: "run_terminal_command", rawInput: { command: "pnpm test" } })).toBe("run_terminal_command");
  });

  it("humanizes stream dumps across providers instead of showing raw JSONL", async () => {
    const { humanizeAgentText } = await import("../backends/cli.js");
    expect(humanizeAgentText('{"type":"item.completed","item":{"type":"agent_message","text":"Codex plan ready"}}')).toBe("Codex plan ready");
    expect(humanizeAgentText('{"type":"result","result":"Claude plan ready"}')).toBe("Claude plan ready");
    expect(humanizeAgentText("Inspect the repository first.")).toBe("Inspect the repository first.");
  });

  it("streams intermediate thinking/text/tools for every CLI provider role", async () => {
    const { createCliActivityStream } = await import("../backends/cli.js");

    const codex = createCliActivityStream("codex", "codex");
    expect(codex.push('{"type":"item.completed","item":{"type":"reasoning","text":"Need to inspect repo layout before planning."}}')).toEqual([
      expect.objectContaining({ kind: "message", phase: "thinking", summary: expect.stringContaining("inspect repo") }),
    ]);
    const codexTool = codex.push('{"type":"item.started","item":{"type":"command_execution","id":"1","command":"ls"}}');
    expect(codexTool.some((item) => item.kind === "tool_call" && item.tool === "shell")).toBe(true);
    expect(codex.push('{"type":"item.started","item":{"type":"mcp_tool_call","id":"mcp-1","server":"runharness_control","tool":"review_accept","arguments":{},"status":"in_progress"}}')).toEqual([
      expect.objectContaining({ kind: "tool_call", tool: "runharness_control__review_accept", callId: "mcp-1" }),
    ]);
    expect(codex.push('{"type":"item.completed","item":{"type":"mcp_tool_call","id":"mcp-1","server":"runharness_control","tool":"review_accept","status":"completed"}}')).toEqual([
      expect.objectContaining({ kind: "tool_result", tool: "runharness_control__review_accept", callId: "mcp-1", success: true }),
    ]);
    expect(codex.push('{"type":"item.completed","item":{"type":"agent_message","text":"Minimal plan ready."}}')).toEqual([
      expect.objectContaining({ kind: "message", phase: "text", summary: "Minimal plan ready." }),
    ]);

    const claude = createCliActivityStream("claude", "claude", "sonnet");
    expect(claude.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reviewer draft: checks look incomplete." }] } }))).toEqual([
      expect.objectContaining({ kind: "message", phase: "text", summary: expect.stringContaining("Reviewer draft") }),
    ]);
    const claudeTool = claude.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "README.md" } }] } }));
    expect(claudeTool.some((item) => item.kind === "tool_call" && item.tool === "Read")).toBe(true);
  });
});

describe("provider conversation mapping", () => {
  it("uses resumable provider sessions without making them the RunHarness source of truth", async () => {
    const base: AgentCall = { cwd: "/workspace", systemPrompt: "system", prompt: "continue", role: "generator", options: { workspaceMode: "write" }, conversation: { runHarnessSessionId: "session", persist: true, providerSessionId: "11111111-1111-4111-8111-111111111111", resume: true } };
    expect(buildCliInvocation("claude", base, []).args).toEqual(expect.arrayContaining(["--resume", "11111111-1111-4111-8111-111111111111"]));
    expect(buildCliInvocation("codex", base, []).args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(buildCliInvocation("codex", base, []).args).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="workspace-write"']));
    expect(buildCliInvocation("codex", base, []).args).not.toContain("--ephemeral");
    const readOnlyResume = buildCliInvocation("codex", { ...base, options: { workspaceMode: "read" } }, []).args;
    expect(readOnlyResume).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="read-only"']));
    expect(buildGrokAcpArguments(base, [])).toEqual(expect.arrayContaining(["agent", "stdio"]));
    const root = path.resolve(".tmp/tests", `provider-conversation-${Date.now()}`); roots.push(root);
    const store = new ProviderConversationStore(root);
    await store.set("session", "codex", "generator", "provider-thread");
    expect(await store.get("session", "codex", "generator")).toBe("provider-thread");
    expect(await store.get("session", "codex", "planner")).toBeUndefined();
  });
});

describe("Agent-owned configuration", () => {
  it("keeps environment and commands isolated per Agent before stage assignment", async () => {
    const root = path.resolve(".tmp/tests", `agent-env-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const script = path.join(root, "env.mjs");
    await writeFile(script, "process.stdin.resume();process.stdin.on('end',()=>console.log(process.env.AGENT_NAME));");
    const backend = (name: string) => ({ type: "cli" as const, command: "mock", executable: process.execPath, args: [script], env: { AGENT_NAME: name } });
    const pool = new AgentPool({ agents: [{ id: "alpha", enabled: true, backend: backend("alpha") }, { id: "beta", enabled: true, backend: backend("beta") }], stages: { planner: ["alpha", "beta"], generator: ["alpha"], evaluator: ["beta"] } });
    const call = { cwd: root, systemPrompt: "system", prompt: "task" };
    expect((await pool.complete("planner", call)).text).toBe("alpha");
    expect((await pool.complete("planner", call, { exclude: ["alpha"] })).text).toBe("beta");
    expect((await pool.complete("evaluator", call)).text).toBe("beta");
    expect(process.env.AGENT_NAME).toBeUndefined();
  });

  it("does not fall through to another Agent after the Run is aborted", async () => {
    const root = path.resolve(".tmp/tests", `agent-abort-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const script = path.join(root, "idle.mjs");
    await writeFile(script, "setInterval(()=>{},1000);");
    const backend = { type: "cli" as const, command: "mock", executable: process.execPath, args: [script] };
    const pool = new AgentPool({ agents: [{ id: "alpha", enabled: true, backend }, { id: "beta", enabled: true, backend }], stages: { planner: ["alpha"], generator: ["alpha", "beta"], evaluator: ["beta"] } });
    const controller = new AbortController(); controller.abort();
    const started: string[] = [];
    await expect(pool.complete("generator", { cwd: root, systemPrompt: "system", prompt: "task", signal: controller.signal, onActivity: (item) => { if (item.kind === "agent_started" && item.agentId) started.push(item.agentId); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toEqual(["alpha"]);
  });
});
