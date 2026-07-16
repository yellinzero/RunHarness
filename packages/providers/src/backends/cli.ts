import { defaultExecutionPolicy, type CliBackendConfig, type ExecutionPolicy, type McpServerConfig, type PermissionRule } from "@runharness/shared";
import type { AgentModelDiscovery, DiscoveredModel } from "@runharness/shared";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import {
  type AgentActivity,
  type AgentBackend,
  type AgentCall,
  type AgentResponse,
  BackendUnavailableError,
} from "../runtime/backend.js";
import { commandExists, runProcess } from "../runtime/process.js";
import { buildClaudeMcpArguments, buildCodexMcpArguments, buildGrokMcpConfig } from "../tools/mcp.js";
import { completeGrokAcp } from "./grok-acp.js";

export class CliAgentBackend implements AgentBackend {
  readonly kind = "cli" as const;
  constructor(
    readonly id: string,
    private readonly config: CliBackendConfig,
  ) {}

  capabilities() {
    const known = this.config.command === "claude" || this.config.command === "codex" || this.config.command === "grok";
    return { imageInput: known, sessionResume: known, streamingActivity: known, networkAccess: known };
  }

  async available(): Promise<boolean> {
    const executable = this.config.executable ?? this.config.command;
    if (!(await commandExists(executable))) return false;
    if (this.config.executable) return true;
    if (this.config.command === "claude") {
      const result = await runProcess(
        executable,
        ["auth", "status", "--json"],
        { cwd: process.cwd(), timeoutMs: 5_000, env: this.environment() },
      );
      try {
        return (
          result.code === 0 &&
          Boolean(
            (JSON.parse(result.stdout) as { loggedIn?: boolean }).loggedIn,
          )
        );
      } catch {
        return false;
      }
    }
    if (this.config.command === "codex")
      return (
        (
          await runProcess(executable, ["login", "status"], {
            cwd: process.cwd(),
            timeoutMs: 5_000,
            env: this.environment(),
          })
        ).code === 0
      );
    if (this.config.command === "grok")
      return (await runProcess(executable, ["models"], { cwd: process.cwd(), timeoutMs: 10_000, env: this.environment() })).code === 0;
    return true;
  }

  async complete(call: AgentCall): Promise<AgentResponse> {
    const executable = this.config.executable ?? this.config.command;
    if (!(await this.available()))
      throw new BackendUnavailableError(
        this.id,
        `CLI executable '${executable}' is not installed or not authenticated`,
      );
    const existingProviderSession = call.conversation?.providerSessionId;
    const assignedProviderSession = !existingProviderSession && (this.config.command === "grok" || (this.config.command === "claude" && call.conversation?.persist)) ? randomUUID() : existingProviderSession;
    const policy = call.options?.executionPolicy as ExecutionPolicy | undefined;
    const policyServers = applyMcpDenyRules(call.mcpServers, policy?.customRules ?? []);
    const invocationCall: AgentCall = assignedProviderSession
      ? { ...call, ...(policyServers ? { mcpServers: policyServers } : {}), conversation: { ...call.conversation!, providerSessionId: assignedProviderSession, resume: Boolean(existingProviderSession) } }
      : { ...call, ...(policyServers ? { mcpServers: policyServers } : {}) };
    const environment = { ...this.environment(), ...call.environment };
    if (this.config.command === "grok") {
      const providerSessionId = assignedProviderSession ?? randomUUID();
      const grokHome = await prepareGrokHome(environment, invocationCall.mcpServers, call.cwd, providerSessionId, policy, call.context ? [path.dirname(call.context.filePath)] : []);
      try {
        const result = await completeGrokAcp({
          executable,
          extraArgs: this.config.args ?? [],
          call: { ...invocationCall, prompt: `# ROLE\n${call.role}\n\n# TASK\n${call.prompt}` },
          env: { ...environment, GROK_HOME: grokHome.directory },
          systemRules: `${call.systemPrompt}${formatProjectRules(policy?.customRules ?? [])}`,
          providerSessionId,
          resume: Boolean(existingProviderSession),
          ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
        });
        await persistGrokSession(grokHome, providerSessionId);
        return {
          text: result.text,
          backend: this.id,
          ...(call.model ? { model: call.model } : {}),
          durationMs: result.durationMs,
          metadata: { command: "grok", transport: "acp-stdio", stderr: result.stderr, stopReason: result.stopReason, usage: result.usage, providerSessionId },
        };
      } catch (error) {
        await persistGrokSession(grokHome, providerSessionId).catch(() => undefined);
        await writeGrokAcpDiagnostic(call, error, { providerSessionId, workspaceMode: call.options?.workspaceMode, approvalMode: policy?.approvalMode }).catch(() => undefined);
        throw error;
      } finally {
        await rm(grokHome.directory, { recursive: true, force: true });
      }
    }
    const { args, input } = buildCliInvocation(
      this.config.command,
      invocationCall,
      this.config.args ?? [],
    );
    const activityStream = createCliActivityStream(this.config.command, this.id, call.model);
    const publishedTools = new Set<string>();
    const activityTasks: Promise<void>[] = [];
    const publish = (items: AgentActivity[]) => {
      for (const item of items) {
        if (item.kind === "tool_call" || item.kind === "tool_result") {
          const key = `${item.kind}:${item.callId ?? ""}:${item.tool ?? ""}`;
          if (publishedTools.has(key)) continue;
          publishedTools.add(key);
        }
        const task = call.onActivity?.(item);
        if (task) activityTasks.push(Promise.resolve(task));
      }
    };
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(executable, args, {
        cwd: call.cwd,
        input,
        env: environment,
        ...(call.signal ? { signal: call.signal } : {}),
        onStdoutLine: (line) => { publish(activityStream.push(line)); },
        ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
      });
      publish(activityStream.flush());
      await Promise.all(activityTasks);
      if (result.code !== 0) {
        throw new Error(`${this.id} exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
      }
    } finally { /* 子进程及其后代由统一进程工具负责清理。 */ }
    const completedProviderSession = providerSessionId(this.config.command, result.stdout) ?? assignedProviderSession;
    return {
      text: extractCliText(this.config.command, result.stdout),
      backend: this.id,
      ...(call.model ? { model: call.model } : {}),
      durationMs: result.durationMs,
      metadata: {
        command: this.config.command,
        stderr: result.stderr.trim(),
        ...(completedProviderSession ? { providerSessionId: completedProviderSession } : {}),
      },
    };
  }

  async discoverModels(): Promise<Omit<AgentModelDiscovery, "agentId">> {
    const executable = this.config.executable ?? this.config.command;
    if (!(await this.available()))
      return { available: false, models: [], source: "unavailable" };
    if (this.config.command === "claude")
      return {
        available: true,
        models: [
          { id: "sonnet", label: "Sonnet" },
          { id: "opus", label: "Opus" },
          { id: "haiku", label: "Haiku" },
        ],
        source: "client",
      };
    if (this.config.command === "codex") {
      const home = this.environment().CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
      const live = await discoverCodexModels(executable, this.environment());
      const models = live?.models.length ? live.models : await readCodexModels(path.join(home, "models_cache.json"));
      const defaultModel = live?.defaultModel || await readCodexDefault(path.join(home, "config.toml"));
      return {
        available: true,
        models,
        ...(defaultModel ? { defaultModel } : {}),
        source: "client",
      };
    }
    if (this.config.command === "grok") {
      const result = await runProcess(executable, ["models"], { cwd: process.cwd(), timeoutMs: 10_000, env: this.environment() });
      const defaultModel = result.stdout.match(/^Default model:\s*(\S+)/m)?.[1] ?? "";
      const models = [...result.stdout.matchAll(/^\s*[-*]\s+(\S+)/gm)].map((match) => ({ id: match[1]!, label: match[1]! }));
      return { available: true, models, ...(defaultModel ? { defaultModel } : {}), source: "client" };
    }
    return { available: true, models: [], source: "client" };
  }

  private environment(): NodeJS.ProcessEnv {
    const expanded = Object.fromEntries(
      Object.entries(this.config.env ?? {}).map(([key, value]) => [
        key,
        value
          .replace(/^~(?=\/|$)/, process.env.HOME ?? "")
          .replaceAll("$HOME", process.env.HOME ?? ""),
      ]),
    );
    return { ...process.env, ...expanded };
  }
}

async function discoverCodexModels(executable: string, env: NodeJS.ProcessEnv): Promise<{ models: DiscoveredModel[]; defaultModel: string } | undefined> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(), env, stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (value?: { models: DiscoveredModel[]; defaultModel: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), 5_000);
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: { data?: Array<{ id?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }> } };
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } })}\n`);
        } else if (message.id === 2) {
          const entries = message.result?.data ?? [];
          const visible = entries.filter((model) => model.id && !model.hidden);
          finish({
            models: visible.map((model) => ({ id: model.id!, label: model.displayName || model.id! })),
            defaultModel: visible.find((model) => model.isDefault)?.id ?? "",
          });
        }
      } catch { /* 忽略非协议输出。 */ }
    });
    child.once("error", () => finish());
    child.once("exit", () => finish());
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "runharness", version: "0.1.0" }, capabilities: {} } })}\n`);
  });
}

async function readCodexModels(file: string): Promise<DiscoveredModel[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed && "models" in parsed && Array.isArray(parsed.models)
        ? parsed.models
        : [];
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const id = typeof item.slug === "string" ? item.slug : "";
      const visibility = typeof item.visibility === "string" ? item.visibility : "";
      if (!id || !["public", "list"].includes(visibility) || item.supported_in_api === false) return [];
      const contextWindowTokens = typeof item.context_window === "number" ? item.context_window : typeof item.context_window_tokens === "number" ? item.context_window_tokens : undefined;
      return [{ id, label: typeof item.display_name === "string" && item.display_name ? item.display_name : id, ...(contextWindowTokens ? { contextWindowTokens } : {}) }];
    });
  } catch {
    return [];
  }
}

async function readCodexDefault(file: string): Promise<string> {
  try {
    const content = await readFile(file, "utf8");
    return content.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function buildCliInvocation(
  command: string,
  call: AgentCall,
  extra: string[],
): { args: string[]; input: string } {
  const images = call.images ?? [];
  if (images.length && command !== "claude" && command !== "codex" && command !== "grok")
    throw new Error(`CLI backend '${command}' does not support image attachments`);
  const imageContext = images.length
    ? `\n\n# IMAGE ATTACHMENTS\n${images.map((image) => `- ${image.name}: ${image.filePath}`).join("\n")}\nInspect these user-provided images as context for this task.`
    : "";
  const writable = call.options?.workspaceMode === "write";
  const policy = (call.options?.executionPolicy as ExecutionPolicy | undefined) ?? { ...defaultExecutionPolicy, workspace: { ...defaultExecutionPolicy.workspace, access: writable ? "read_write" : "read_only" }, network: call.options?.networkAccess === true ? "allow_all" : "deny" };
  const mcpServers = applyMcpDenyRules(call.mcpServers, policy.customRules);
  const policyContext = formatProjectRules(policy.customRules);
  const prompt = `${call.systemPrompt}${policyContext}\n\n# ROLE\n${call.role}\n\n# TASK\n${call.prompt}${imageContext}`;
  const allowAll = policy.approvalMode === "allow_all" && policy.customRules.length === 0;
  const networkAllowed = writable && policy.network !== "deny";
  if (command === "claude")
    return {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        writable ? allowAll ? "bypassPermissions" : "auto" : "dontAsk",
        ...(writable && allowAll ? ["--dangerously-skip-permissions"] : []),
        ...(!call.conversation?.persist ? ["--no-session-persistence"] : call.conversation.providerSessionId ? [call.conversation.resume ? "--resume" : "--session-id", call.conversation.providerSessionId] : []),
        ...(writable ? ["--add-dir", call.cwd] : []),
        ...(writable ? [...new Set(call.writableRoots ?? [])].flatMap((directory) => ["--add-dir", directory]) : []),
        ...(call.context ? ["--add-dir", path.dirname(call.context.filePath)] : []),
        ...[...new Set(images.map((image) => path.dirname(image.filePath)))].flatMap((directory) => ["--add-dir", directory]),
        ...(call.model ? ["--model", call.model] : []),
        ...buildClaudeMcpArguments(mcpServers, allowAll),
        ...extra,
      ],
      input: prompt,
    };
  if (command === "codex") {
    const resumed = call.conversation?.resume && call.conversation.providerSessionId;
    const approvalPolicy = writable && !allowAll ? "on-request" : "never";
    const approvalReviewer = writable && !allowAll ? ["-c", 'approvals_reviewer="auto_review"'] : [];
    return {
      args: resumed ? [
        "exec", "resume", "--json",
        "-c", `sandbox_mode=${JSON.stringify(writable ? "workspace-write" : "read-only")}`,
        ...(networkAllowed ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
        "-c", `approval_policy=${JSON.stringify(approvalPolicy)}`,
        ...approvalReviewer,
        ...images.flatMap((image) => ["--image", image.filePath]),
        ...(call.model ? ["--model", call.model] : []),
        ...buildCodexMcpArguments(mcpServers, call.cwd, allowAll), ...extra, call.conversation!.providerSessionId!, "-",
      ] : [
        "exec", ...(!call.conversation?.persist ? ["--ephemeral"] : []), "--color", "never", "--json",
        "--sandbox", writable ? "workspace-write" : "read-only",
        ...(networkAllowed ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
        "-c", `approval_policy=${JSON.stringify(approvalPolicy)}`,
        ...approvalReviewer,
        "--cd", call.cwd,
        ...(writable ? [...new Set(call.writableRoots ?? [])].flatMap((directory) => ["--add-dir", directory]) : []),
        ...images.flatMap((image) => ["--image", image.filePath]),
        ...(call.model ? ["--model", call.model] : []),
        ...buildCodexMcpArguments(mcpServers, call.cwd, allowAll), ...extra, "-",
      ],
      input: prompt,
    };
  }
  return { args: [...extra], input: prompt };
}

function formatProjectRules(rules: PermissionRule[]): string {
  if (!rules.length) return "";
  return `\n\n# RUNHARNESS PROJECT RULES\nThese rules are part of the project execution policy. Never request or execute a denied action. Actions marked ask require provider or human approval before execution.\n${rules.map((rule) => `- ${rule.decision.toUpperCase()} ${rule.scope} ${JSON.stringify(rule.pattern)}${rule.description ? `: ${rule.description}` : ""}`).join("\n")}`;
}

function applyMcpDenyRules(servers: AgentCall["mcpServers"], rules: PermissionRule[]): AgentCall["mcpServers"] {
  if (!servers) return servers;
  const denied = rules.filter((rule) => rule.scope === "mcp_tool" && rule.decision === "deny" && !/[?*]/.test(rule.pattern));
  if (!denied.length) return servers;
  const next: Record<string, McpServerConfig> = Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, { ...config, disabledTools: [...(config.disabledTools ?? [])] }]));
  for (const rule of denied) {
    const separator = rule.pattern.indexOf("/");
    if (separator <= 0) continue;
    const server = rule.pattern.slice(0, separator); const tool = rule.pattern.slice(separator + 1);
    const config = next[server];
    if (!config || !tool) continue;
    config.disabledTools = [...new Set([...(config.disabledTools ?? []), tool])];
  }
  return next;
}

export function extractCliText(command: string, stdout: string): string {
  const records = jsonLines(stdout);
  if (command === "claude") {
    const result = [...records].reverse().find((record) => record.type === "result");
    if (typeof result?.result === "string") return result.result;
    const assistant = records.flatMap((record) => record.type === "assistant" ? textBlocks(record.message) : []).join("\n").trim();
    // 不能回退显示原始 stream-json；取消或不完整执行只会留下协议噪声。
    return assistant;
  }
  if (command === "codex") {
    const messages = records.flatMap((record) => {
      const item = asRecord(record.item);
      return record.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
    });
    // 优先使用最后一条 Agent 消息，不能把 item.* 协议行当成正文。
    return messages.at(-1) ?? "";
  }
  // 未知 CLI backend 如果输出 JSONL 协议流，也不能将其误当自然语言正文。
  if (looksLikeStreamingJsonDump(stdout)) return humanizeAgentText(stdout);
  return stdout.trim();
}

/**
 * 将 Provider 原始流式输出收敛为可读正文。
 * 统一处理 Claude stream-json、Codex item JSONL 和普通文本。
 */
export function humanizeAgentText(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!looksLikeStreamingJsonDump(raw)) return raw;
  const records = jsonLines(raw);
  if (!records.length) return raw;

  // 优先采用协议终态结果，其次采用已完成的 assistant 正文。
  const claudeResult = [...records].reverse().find((record) => record.type === "result" && typeof record.result === "string");
  if (typeof claudeResult?.result === "string" && claudeResult.result.trim()) return claudeResult.result.trim();
  const claudeText = records.flatMap((record) => record.type === "assistant" ? textBlocks(record.message) : []).join("\n").trim();
  if (claudeText) return claudeText;

  // item 协议流以最后一条完成的 Agent 消息作为最终正文。
  const codexMessages = records.flatMap((record) => {
    const item = asRecord(record.item);
    return (record.type === "item.completed" || record.type === "item.updated") && item?.type === "agent_message" && typeof item.text === "string"
      ? [item.text]
      : [];
  });
  if (codexMessages.length) return codexMessages.at(-1)!.replace(/\s+/g, " ").trim();

  const end = [...records].reverse().find((record) => record.type === "end" || record.type === "result" || record.type === "error");
  if (end) {
    if (typeof end.stopReason === "string") {
      return end.stopReason === "Cancelled" ? "Agent run was cancelled before a final answer." : `Agent stopped (${end.stopReason}).`;
    }
    if (typeof end.error === "string") return end.error;
    if (typeof end.message === "string") return end.message;
  }
  return "Agent produced no readable final text.";
}

function looksLikeStreamingJsonDump(value: string): boolean {
  const sample = value.slice(0, 320).trim();
  if (!sample.startsWith("{") && !sample.startsWith("[")) return false;
  return (
    sample.includes('"type":"assistant"')
    || sample.includes('"type":"result"')
    || sample.includes('"type":"item.started"')
    || sample.includes('"type":"item.completed"')
    || sample.includes('"type":"content_block')
    || sample.includes('"type":"message_')
  );
}

const ACTIVITY_EMIT_MS = 750;
const ACTIVITY_EMIT_CHARS = 80;
const ACTIVITY_SNIPPET = 240;

/**
 * 面向所有角色的有状态 CLI 流解析器。
 * 工具事件立即发出，思考和正文按频率节流，使过程可观察且不会淹没界面。
 */
export function createCliActivityStream(command: string, backend: string, model?: string) {
  const base = { backend, ...(model ? { model } : {}) };
  const pendingToolNames = new Map<string, string>();
  let phase: "thinking" | "text" | undefined;
  let buffer = "";
  let lastEmitAt = 0;
  let lastEmitted = "";

  const snapshot = (force: boolean): AgentActivity | undefined => {
    const text = buffer.replace(/\s+/g, " ").trim();
    if (!text || text === lastEmitted) return undefined;
    const now = Date.now();
    if (!force && now - lastEmitAt < ACTIVITY_EMIT_MS && text.length - lastEmitted.length < ACTIVITY_EMIT_CHARS) return undefined;
    lastEmitAt = now;
    lastEmitted = text;
    const summary = text.length > ACTIVITY_SNIPPET ? `…${text.slice(-(ACTIVITY_SNIPPET - 1))}` : text;
    return { kind: "message", ...base, phase: phase ?? "text", summary };
  };

  const append = (nextPhase: "thinking" | "text", chunk: string, force = false): AgentActivity[] => {
    if (!chunk) return [];
    if (phase && phase !== nextPhase) {
      const flushed = snapshot(true);
      buffer = chunk;
      phase = nextPhase;
      lastEmitted = "";
      lastEmitAt = 0; // 所有角色进入新阶段时都应立即显示第一条过程消息。
      const next = snapshot(true);
      return [flushed, next].filter((item): item is AgentActivity => Boolean(item));
    }
    phase = nextPhase;
    buffer += chunk;
    const item = snapshot(force || !lastEmitted);
    return item ? [item] : [];
  };

  const withToolBoundary = (tools: AgentActivity[]): AgentActivity[] => {
    const flushed = snapshot(true);
    buffer = "";
    phase = undefined;
    lastEmitted = "";
    return flushed ? [flushed, ...tools] : tools;
  };

  return {
    push(line: string): AgentActivity[] {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { return []; }

      const parsedTool = parseCliToolActivity(command, record, base);
      if (parsedTool) {
        const tool = normalizeToolActivity(parsedTool, pendingToolNames);
        return withToolBoundary([tool]);
      }

      if (command === "claude") {
        if (record.type === "content_block_delta") {
          const delta = asRecord(record.delta);
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") return append("thinking", delta.thinking);
          if (delta?.type === "text_delta" && typeof delta.text === "string") return append("text", delta.text);
        }
        if (record.type === "assistant") {
          const message = asRecord(record.message);
          const blocks = Array.isArray(message?.content) ? message.content.map(asRecord).filter(Boolean) : [];
          const thinking = blocks.filter((block) => block?.type === "thinking" || block?.type === "reasoning").map((block) => String(block?.thinking ?? block?.text ?? "")).join("");
          const text = blocks.filter((block) => block?.type === "text").map((block) => String(block?.text ?? "")).join("");
          const out: AgentActivity[] = [];
          if (thinking) out.push(...append("thinking", thinking, true));
          if (text) out.push(...append("text", text, true));
          return out;
        }
      }

      if (command === "codex") {
        const item = asRecord(record.item);
        if (!item) return [];
        // Planner 和 Evaluator 的推理、正文同样需要流式展示，不只观察 Generator 工具。
        if (item.type === "reasoning" || item.type === "agent_reasoning") {
          const text = String(item.text ?? item.summary ?? item.content ?? "");
          if (text) return append("thinking", text, record.type === "item.completed");
        }
        if (item.type === "agent_message") {
          const text = String(item.text ?? "");
          if (text) {
            // updated 帧视为渐进草稿，completed 帧强制形成最终快照。
            if (record.type === "item.updated" || record.type === "item.started") {
              phase = "text";
              buffer = text;
              const itemActivity = snapshot(false);
              return itemActivity ? [itemActivity] : [];
            }
            if (record.type === "item.completed") {
              phase = "text";
              buffer = text;
              const itemActivity = snapshot(true);
              return itemActivity ? [itemActivity] : [];
            }
          }
        }
        if (item.type === "todo_list" && record.type === "item.completed") {
          const summary = "Updated task list";
          return [{ kind: "message", ...base, phase: "status", summary }];
        }
      }

      return [];
    },
    flush(): AgentActivity[] {
      const item = snapshot(true);
      return item ? [item] : [];
    },
  };
}

function parseCliToolActivity(command: string, record: Record<string, unknown>, base: { backend: string; model?: string }): AgentActivity | undefined {
  if (command === "codex") {
    const item = asRecord(record.item); if (!item) return undefined;
    const mcpTool = item.type === "mcp_tool_call" ? canonicalMcpTool(item.server, item.tool) : undefined;
    const tool = item.type === "command_execution" ? "shell"
      : item.type === "file_change" ? "file change"
      : item.type === "mcp_tool_call" ? mcpTool ?? "MCP tool"
      : item.type === "web_search" ? "web search"
      : item.type === "image_view" || item.type === "view_image" ? "image"
      : undefined;
    if (!tool) return undefined;
    const summary = tool === "shell" ? String(item.command ?? "command")
      : tool === "file change" ? "Editing files"
      : tool === "web search" ? String(item.query ?? item.summary ?? "search")
      : String(item.tool ?? item.path ?? tool);
    if (record.type === "item.started") return { kind: "tool_call", ...base, tool, callId: String(item.id ?? ""), summary };
    if (record.type === "item.completed") return { kind: "tool_result", ...base, tool, callId: String(item.id ?? ""), summary, success: item.status !== "failed" };
  }
  if (command === "claude") {
    const message = asRecord(record.message);
    const blocks = Array.isArray(message?.content) ? message.content.map(asRecord).filter(Boolean) : [];
    const toolUse = blocks.find((block) => block?.type === "tool_use");
    if (toolUse) return { kind: "tool_call", ...base, tool: String(toolUse.name ?? "tool"), callId: String(toolUse.id ?? ""), summary: summarizeToolInput(toolUse.input) };
    const toolResult = blocks.find((block) => block?.type === "tool_result");
    if (toolResult) return { kind: "tool_result", ...base, tool: "tool", callId: String(toolResult.tool_use_id ?? ""), success: toolResult.is_error !== true };
    // 部分流式协议会把 tool_use 放在顶层。
    if (record.type === "tool_use" || record.type === "tool_call") {
      return { kind: "tool_call", ...base, tool: String(record.name ?? "tool"), callId: String(record.id ?? ""), summary: summarizeToolInput(record.input) };
    }
  }
  return undefined;
}

function canonicalMcpTool(server: unknown, tool: unknown): string | undefined {
  if (typeof tool !== "string" || !tool) return undefined;
  if (tool.includes("__") || typeof server !== "string" || !server) return tool;
  // Codex JSONL 将 MCP server 和 tool 分字段输出，Provider 边界统一恢复为 server__tool。
  return `${server}__${tool}`;
}

function normalizeToolActivity(activity: AgentActivity, pending: Map<string, string>): AgentActivity {
  const callId = activity.callId ?? "";
  if (activity.kind === "tool_call") {
    if (callId && activity.tool) pending.set(callId, activity.tool);
    return activity;
  }
  if (activity.kind !== "tool_result") return activity;
  const tool = callId ? pending.get(callId) ?? activity.tool : activity.tool;
  if (callId) pending.delete(callId);
  return { ...activity, ...(tool ? { tool } : {}) };
}

function jsonLines(value: string): Record<string, unknown>[] {
  try {
    const document = JSON.parse(value) as unknown;
    if (document && typeof document === "object" && !Array.isArray(document)) return [document as Record<string, unknown>];
  } catch { /* 流式 Provider 通常每行输出一个 JSON 对象，非 JSON 行留给普通文本路径。 */ }
  return value.split("\n").flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
}

function providerSessionId(command: string, stdout: string): string | undefined {
  const records = jsonLines(stdout);
  if (command === "codex") {
    const started = records.find((record) => record.type === "thread.started");
    return typeof started?.thread_id === "string" ? started.thread_id : typeof started?.threadId === "string" ? started.threadId : undefined;
  }
  if (command === "claude") {
    const record = records.find((item) => typeof item.session_id === "string") ?? records.find((item) => typeof item.sessionId === "string");
    return typeof record?.session_id === "string" ? record.session_id : typeof record?.sessionId === "string" ? record.sessionId : undefined;
  }
  return undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; }
function textBlocks(value: unknown): string[] { const message = asRecord(value); return Array.isArray(message?.content) ? message.content.flatMap((block) => { const item = asRecord(block); return item?.type === "text" && typeof item.text === "string" ? [item.text] : []; }) : []; }
function summarizeToolInput(value: unknown): string { const input = asRecord(value); return String(input?.command ?? input?.path ?? input?.file_path ?? input?.query ?? "").slice(0, 180); }

interface PreparedGrokHome { directory: string; source: string; projectKey: string }

async function prepareGrokHome(environment: NodeJS.ProcessEnv, servers: AgentCall["mcpServers"], cwd: string, providerSessionId?: string, policy?: ExecutionPolicy, readOnlyRoots: string[] = []): Promise<PreparedGrokHome> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runharness-grok-"));
  const source = environment.GROK_HOME ?? path.join(process.env.HOME ?? "", ".grok");
  const projectKey = encodeURIComponent(path.resolve(cwd));
  try {
    await Promise.all(["auth.json", "agent_id", "models_cache.json"].map(async (file) => {
      try { const target = path.join(directory, file); await copyFile(path.join(source, file), target); await chmod(target, 0o600); } catch { /* 可选 Provider 状态缺失不影响本次调用。 */ }
    }));
    await writeFile(path.join(directory, "config.toml"), buildGrokMcpConfig(servers, cwd, policy, readOnlyRoots), { mode: 0o600 });
    if (providerSessionId) {
      const sourceSession = path.join(source, "sessions", projectKey, providerSessionId);
      const targetSession = path.join(directory, "sessions", projectKey, providerSessionId);
      try { await mkdir(path.dirname(targetSession), { recursive: true }); await cp(sourceSession, targetSession, { recursive: true, force: true }); } catch { /* 可恢复会话缺失时由 Provider 在加载阶段报告。 */ }
    }
    return { directory, source, projectKey };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function persistGrokSession(home: PreparedGrokHome, providerSessionId: string): Promise<void> {
  const sourceSession = path.join(home.directory, "sessions", home.projectKey, providerSessionId);
  const targetSession = path.join(home.source, "sessions", home.projectKey, providerSessionId);
  await mkdir(path.dirname(targetSession), { recursive: true });
  await cp(sourceSession, targetSession, { recursive: true, force: true });
}

async function writeGrokAcpDiagnostic(call: AgentCall, error: unknown, effective: Record<string, unknown>): Promise<void> {
  if (!call.context?.filePath) return;
  const file = path.join(path.dirname(call.context.filePath), `grok-${call.role}-diagnostic.json`);
  await writeFile(file, JSON.stringify({
    provider: "grok",
    role: call.role,
    capturedAt: new Date().toISOString(),
    transport: "acp-stdio",
    effective,
    failure: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
  }, null, 2));
}
