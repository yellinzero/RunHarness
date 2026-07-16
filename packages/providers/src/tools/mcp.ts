import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExecutionPolicy, McpServerConfig, McpServerStatus, PermissionDecision, PermissionRule, StdioMcpServerConfig } from "@runharness/shared";
import path from "node:path";
import type { AgentCall } from "../runtime/backend.js";
import { CONTROL_SERVER_NAME } from "./control-tools.js";
import { evaluatePermission, mcpAnnotationDecision, mcpPermissionAction, type McpToolAnnotations } from "./permissions.js";

const serverNamePattern = /^[A-Za-z0-9_-]+$/;

export function validateMcpServers(value: unknown): asserts value is Record<string, McpServerConfig> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mcpServers must be an object");
  for (const [name, config] of Object.entries(value)) validateServer(name, config as McpServerConfig);
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolPolicy {
  annotations?: McpToolAnnotations;
}

export class PermissionRequiredError extends Error {
  constructor(readonly action: ReturnType<typeof mcpPermissionAction>, readonly decision: PermissionDecision) {
    super(`MCP action requires approval: ${decision.reason}`);
    this.name = "PermissionRequiredError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(readonly action: ReturnType<typeof mcpPermissionAction>, readonly decision: PermissionDecision) {
    super(`Permission denied: ${decision.reason}`);
    this.name = "PermissionDeniedError";
  }
}

/** 持有 MCP 客户端连接，并在每次工具执行前应用统一权限策略。 */
export class McpToolSession {
  private constructor(
    readonly tools: McpToolDefinition[],
    private readonly clients: Map<string, { client: Client; timeoutMs: number }>,
    private readonly policies: Map<string, McpToolPolicy>,
  ) {}

  static async open(servers: Record<string, McpServerConfig> | undefined, projectDir: string) {
    const clients = new Map<string, { client: Client; timeoutMs: number }>();
    const tools: McpToolDefinition[] = [];
    const policies = new Map<string, McpToolPolicy>();
    try {
      for (const [name, config] of enabledServerEntries(servers)) {
        const client = new Client({ name: "runharness", version: "0.1.0" }, { capabilities: {} });
        const timeoutMs = config.toolTimeoutMs ?? 60_000;
        const transport = createTransport(config, projectDir);
        await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: config.startupTimeoutMs ?? 15_000 });
        clients.set(name, { client, timeoutMs });
        const listed = await client.listTools(undefined, { timeout: config.startupTimeoutMs ?? 15_000 });
        const enabledNames = config.enabledTools ? new Set(config.enabledTools) : undefined;
        const disabledNames = new Set(config.disabledTools ?? []);
        for (const tool of listed.tools) {
          if ((enabledNames && !enabledNames.has(tool.name)) || disabledNames.has(tool.name)) continue;
          const exposedName = `mcp__${name}__${tool.name}`;
          tools.push({
            name: exposedName,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
          });
          policies.set(exposedName, {
            ...(tool.annotations ? { annotations: {
              ...(tool.annotations.destructiveHint !== undefined ? { destructiveHint: tool.annotations.destructiveHint } : {}),
              ...(tool.annotations.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
              ...(tool.annotations.openWorldHint !== undefined ? { openWorldHint: tool.annotations.openWorldHint } : {}),
            } } : {}),
          });
        }
      }
      return new McpToolSession(tools, clients, policies);
    } catch (error) {
      await Promise.allSettled([...clients.values()].map(({ client }) => client.close()));
      throw error;
    }
  }

  async call(name: string, input: Record<string, unknown>, permission?: AgentCall["permission"], options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const toolPolicy = this.policies.get(name);
    const action = mcpPermissionAction(name, input, toolPolicy?.annotations);
    let decision: PermissionDecision;
    if (permission) {
      decision = evaluatePermission(permission.policy, action);
      if (decision.decision === "allow" && decision.source !== "custom_rule" && permission.policy.approvalMode !== "allow_all")
        decision = mcpAnnotationDecision(action, toolPolicy?.annotations) ?? decision;
      decision = await permission.decide(action, decision);
    } else {
      decision = requiresApproval(toolPolicy?.annotations)
        ? { decision: "ask", source: "builtin", reason: "MCP annotations require approval" }
        : { decision: "allow", source: "builtin", reason: "MCP annotations describe a read-only tool" };
    }
    if (decision.decision === "ask") throw new PermissionRequiredError(action, decision);
    if (decision.decision === "deny") throw new PermissionDeniedError(action, decision);
    const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(name);
    if (!match) throw new Error(`Unknown MCP tool '${name}'`);
    const entry = this.clients.get(match[1]!);
    if (!entry) throw new Error(`MCP server '${match[1]}' is not connected`);
    const result = await entry.client.callTool(
      { name: match[2]!, arguments: input },
      undefined,
      { timeout: options.timeoutMs ?? entry.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
    );
    return formatToolResult(result);
  }

  async close() {
    await Promise.allSettled([...this.clients.values()].map(({ client }) => client.close()));
  }
}

export async function discoverMcpServers(
  servers: Record<string, McpServerConfig> = {},
  projectDir = process.cwd(),
): Promise<McpServerStatus[]> {
  return Promise.all(Object.entries(servers).map(([name, config]) => discoverServer(name, config, projectDir)));
}

export function buildClaudeMcpArguments(
  servers: Record<string, McpServerConfig> | undefined,
  allowAll = false,
): string[] {
  const entries = enabledServerEntries(servers);
  const configured = Object.fromEntries(entries.map(([name, config]) => [name, isStdio(config)
    ? {
        type: "stdio",
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: expandEnvironment(config.env) } : {}),
      }
    : {
        type: "http",
        url: config.url,
        ...(config.headers ? { headers: expandEnvironment(config.headers) } : {}),
      }]));
  const allowed = entries.flatMap(([name, config]) => allowAll || name === CONTROL_SERVER_NAME ? config.enabledTools?.length ? config.enabledTools.map((tool) => `mcp__${name}__${tool}`) : [`mcp__${name}__*`] : []);
  const denied = entries.flatMap(([name, config]) => (config.disabledTools ?? []).map((tool) => `mcp__${name}__${tool}`));
  return ["--mcp-config", JSON.stringify({ mcpServers: configured }), "--strict-mcp-config", ...(allowed.length ? ["--allowedTools", ...allowed] : []), ...(denied.length ? ["--disallowedTools", ...denied] : [])];
}

export function buildCodexMcpArguments(
  servers: Record<string, McpServerConfig> | undefined,
  projectDir: string,
  allowAll = false,
): string[] {
  const configured = Object.fromEntries(enabledServerEntries(servers).map(([name, config]) => [name, isStdio(config)
    ? {
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: expandEnvironment(config.env) } : {}),
        ...(config.cwd ? { cwd: resolveCwd(projectDir, config.cwd) } : {}),
        ...(config.startupTimeoutMs ? { startup_timeout_ms: config.startupTimeoutMs } : {}),
        ...(config.toolTimeoutMs ? { tool_timeout_sec: config.toolTimeoutMs / 1000 } : {}),
        default_tools_approval_mode: allowAll ? "approve" : "auto",
        ...(config.enabledTools?.length ? { enabled_tools: config.enabledTools } : {}),
        ...(config.disabledTools?.length ? { disabled_tools: config.disabledTools } : {}),
      }
    : {
        url: config.url,
        ...(config.headers ? { http_headers: expandEnvironment(config.headers) } : {}),
        ...(config.startupTimeoutMs ? { startup_timeout_ms: config.startupTimeoutMs } : {}),
        ...(config.toolTimeoutMs ? { tool_timeout_sec: config.toolTimeoutMs / 1000 } : {}),
        default_tools_approval_mode: allowAll ? "approve" : "auto",
        ...(config.enabledTools?.length ? { enabled_tools: config.enabledTools } : {}),
        ...(config.disabledTools?.length ? { disabled_tools: config.disabledTools } : {}),
      }]));
  if (!Object.keys(configured).length) return ["-c", "mcp_servers={}"];
  return ["-c", `mcp_servers=${tomlInlineTable(configured)}`];
}

export function buildGrokMcpConfig(servers: Record<string, McpServerConfig> | undefined, projectDir: string, policy?: ExecutionPolicy, readOnlyRoots: string[] = []): string {
  const lines = [
    "[compat.cursor]", "mcps = false", "", "[compat.claude]", "mcps = false", "", "[compat.codex]", "mcps = false",
  ];
  const nativeRules = grokPermissionRules(policy?.customRules ?? []);
  const protectedRead = readOnlyRoots.map((root) => `Read(${root}/**)`);
  const protectedWrite = readOnlyRoots.map((root) => `Edit(${root}/**)`);
  if (nativeRules.ask.length || nativeRules.deny.length || protectedRead.length) {
    lines.push("", "[permission]");
    if (protectedRead.length) lines.push(`allow = ${tomlValue(protectedRead)}`);
    if (nativeRules.ask.length) lines.push(`ask = ${tomlValue(nativeRules.ask)}`);
    if (nativeRules.deny.length || protectedWrite.length) lines.push(`deny = ${tomlValue([...nativeRules.deny, ...protectedWrite])}`);
  }
  for (const [name, config] of enabledServerEntries(servers)) {
    lines.push("", `[mcp_servers.${JSON.stringify(name)}]`);
    if (isStdio(config)) {
      lines.push(`command = ${JSON.stringify(config.command)}`);
      if (config.args?.length) lines.push(`args = ${tomlValue(config.args)}`);
      if (config.env) lines.push(`env = ${tomlValue(expandEnvironment(config.env))}`);
      if (config.cwd) lines.push(`cwd = ${JSON.stringify(resolveCwd(projectDir, config.cwd))}`);
    } else {
      lines.push(`url = ${JSON.stringify(config.url)}`);
      if (config.headers) lines.push(`headers = ${tomlValue(expandEnvironment(config.headers))}`);
    }
    lines.push("enabled = true");
    if (config.startupTimeoutMs) lines.push(`startup_timeout_sec = ${config.startupTimeoutMs / 1000}`);
    if (config.toolTimeoutMs) lines.push(`tool_timeout_sec = ${config.toolTimeoutMs / 1000}`);
  }
  return `${lines.join("\n")}\n`;
}

export function grokPermissionRules(rules: PermissionRule[]): { ask: string[]; deny: string[] } {
  const result = { ask: [] as string[], deny: [] as string[] };
  for (const rule of rules) {
    if (rule.decision === "allow") continue;
    const target = rule.decision === "ask" ? result.ask : result.deny;
    target.push(...grokRulePatterns(rule));
  }
  return result;
}

function grokRulePatterns(rule: PermissionRule): string[] {
  if (rule.scope === "command") return [`Bash(${rule.pattern})`];
  if (rule.scope === "path") return [`Read(${rule.pattern})`, `Edit(${rule.pattern})`];
  if (rule.scope === "origin") return [`WebFetch(${rule.pattern})`];
  if (rule.scope === "mcp_tool") return [`MCPTool(${rule.pattern.replace("/", "__")})`];
  if (rule.pattern === "command" || rule.pattern === "git" || rule.pattern === "deployment") return ["Bash"];
  if (rule.pattern === "file") return ["Read", "Edit"];
  if (rule.pattern === "network") return ["WebFetch"];
  if (rule.pattern === "mcp") return ["MCPTool"];
  return [];
}

function enabledServerEntries(servers: Record<string, McpServerConfig> | undefined): Array<[string, McpServerConfig]> {
  return Object.entries(servers ?? {}).filter(([name, config]) => {
    validateServer(name, config);
    return config.enabled !== false;
  });
}

async function discoverServer(name: string, config: McpServerConfig, projectDir: string): Promise<McpServerStatus> {
  const enabled = config.enabled !== false;
  if (!enabled) return { name, enabled, available: false, tools: [] };
  let client: Client | undefined;
  try {
    validateServer(name, config);
    client = new Client({ name: "runharness", version: "0.1.0" }, { capabilities: {} });
    const timeout = config.startupTimeoutMs ?? 15_000;
    const transport = createTransport(config, projectDir);
    await client.connect(transport as Parameters<Client["connect"]>[0], { timeout });
    const result = await client.listTools(undefined, { timeout: config.toolTimeoutMs ?? timeout });
    const enabledNames = config.enabledTools ? new Set(config.enabledTools) : undefined;
    const disabledNames = new Set(config.disabledTools ?? []);
    const advertisedNames = new Set(result.tools.map((tool) => tool.name));
    const unknownDisabledTools = [...disabledNames].filter((tool) => !advertisedNames.has(tool));
    const tools = result.tools
      .filter((tool) => (!enabledNames || enabledNames.has(tool.name)) && !disabledNames.has(tool.name))
      .map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }));
    return { name, enabled, available: true, tools, ...(unknownDisabledTools.length ? { unknownDisabledTools } : {}) };
  } catch (error) {
    return { name, enabled, available: false, tools: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function validateServer(name: string, config: McpServerConfig) {
  if (!serverNamePattern.test(name)) throw new Error(`MCP server name '${name}' may only contain letters, numbers, '_' and '-'`);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`MCP server '${name}' must be an object`);
  const allowed = new Set(["command", "args", "env", "cwd", "url", "headers", "enabled", "startupTimeoutMs", "toolTimeoutMs", "enabledTools", "disabledTools"]);
  const unknown = Object.keys(config).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`MCP server '${name}' has unsupported option '${unknown}'`);
  const hasCommand = "command" in config && typeof config.command === "string" && Boolean(config.command.trim());
  const hasUrl = "url" in config && typeof config.url === "string" && Boolean(config.url.trim());
  if (hasCommand === hasUrl) throw new Error(`MCP server '${name}' requires exactly one of command or url`);
  if (hasUrl) new URL(config.url);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error(`MCP server '${name}' enabled must be boolean`);
  validateStringArray(name, "args", "args" in config ? config.args : undefined);
  validateStringMap(name, "env", "env" in config ? config.env : undefined);
  validateStringMap(name, "headers", "headers" in config ? config.headers : undefined);
  validatePositiveInteger(name, "startupTimeoutMs", config.startupTimeoutMs);
  validatePositiveInteger(name, "toolTimeoutMs", config.toolTimeoutMs);
  validateStringArray(name, "enabledTools", config.enabledTools);
  validateStringArray(name, "disabledTools", config.disabledTools);
  const disabled = new Set(config.disabledTools ?? []);
  const overlap = (config.enabledTools ?? []).find((tool) => disabled.has(tool));
  if (overlap) throw new Error(`MCP server '${name}' tool '${overlap}' cannot be both enabled and disabled`);
}

function isStdio(config: McpServerConfig): config is McpServerConfig & StdioMcpServerConfig {
  return typeof config.command === "string";
}

function validateStringArray(server: string, field: string, value: unknown) {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)))
    throw new Error(`MCP server '${server}' ${field} must contain non-empty strings`);
}

function validateStringMap(server: string, field: string, value: unknown) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")))
    throw new Error(`MCP server '${server}' ${field} must contain string values`);
}

function validatePositiveInteger(server: string, field: string, value: unknown) {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) <= 0))
    throw new Error(`MCP server '${server}' ${field} must be a positive integer`);
}

function createTransport(config: McpServerConfig, projectDir: string) {
  return isStdio(config)
    ? new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: { ...process.env, ...expandEnvironment(config.env) } as Record<string, string> } : {}),
        ...(config.cwd ? { cwd: resolveCwd(projectDir, config.cwd) } : { cwd: projectDir }),
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        ...(config.headers ? { requestInit: { headers: expandEnvironment(config.headers) } } : {}),
      });
}

function requiresApproval(annotations: { destructiveHint?: boolean | undefined; readOnlyHint?: boolean | undefined; openWorldHint?: boolean | undefined } | undefined) {
  if (annotations?.destructiveHint === true) return true;
  if (annotations?.openWorldHint === true) return true;
  return annotations?.readOnlyHint !== true;
}

function formatToolResult(value: unknown) {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const contentItems = Array.isArray(result.content) ? result.content : [];
  const text = contentItems.map((item) => {
    if (!item || typeof item !== "object") return String(item);
    const content = item as Record<string, unknown>;
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (content.type === "resource" && content.resource && typeof content.resource === "object") {
      const resource = content.resource as Record<string, unknown>;
      return typeof resource.text === "string" ? resource.text : JSON.stringify(resource);
    }
    if (content.type === "image") return `[image ${String(content.mimeType ?? "")}]`;
    return JSON.stringify(content);
  }).join("\n");
  return { output: text || JSON.stringify(result.structuredContent ?? result.toolResult ?? {}), isError: result.isError === true };
}

function resolveCwd(projectDir: string, cwd: string) {
  return path.isAbsolute(cwd) ? cwd : path.resolve(projectDir, cwd);
}

function expandEnvironment(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value
    .replace(/^~(?=\/|$)/, process.env.HOME ?? "")
    .replaceAll("$HOME", process.env.HOME ?? "")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")]));
}

function tomlInlineTable(value: Record<string, unknown>): string {
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
}

function tomlValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") return tomlInlineTable(value as Record<string, unknown>);
  throw new Error("Unsupported MCP configuration value");
}
