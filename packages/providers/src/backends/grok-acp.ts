import * as acp from "@agentclientprotocol/sdk";
import type { ExecutionPolicy } from "@runharness/shared";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import type { AgentCall } from "../runtime/backend.js";
import { PermissionRequiredError } from "../tools/mcp.js";
import { evaluatePermission, providerToolPermissionAction } from "../tools/permissions.js";

export interface GrokAcpResult {
  text: string;
  sessionId: string;
  stopReason: acp.StopReason;
  usage?: acp.Usage | null;
  stderr: string;
  durationMs: number;
}

export function buildGrokAcpArguments(call: AgentCall, extra: string[]): string[] {
  const writable = call.options?.workspaceMode === "write";
  return [
    "--cwd", call.cwd,
    "--no-subagents",
    ...(!writable ? ["--sandbox", "read-only"] : []),
    ...extra,
    "agent",
    ...(call.model ? ["--model", call.model] : []),
    "stdio",
  ];
}

export async function completeGrokAcp(input: {
  executable: string;
  extraArgs: string[];
  call: AgentCall;
  env: NodeJS.ProcessEnv;
  systemRules: string;
  providerSessionId: string;
  resume: boolean;
  timeoutMs?: number;
}): Promise<GrokAcpResult> {
  const started = Date.now();
  const child = spawn(input.executable, buildGrokAcpArguments(input.call, input.extraArgs), {
    cwd: input.call.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const terminate = () => {
    if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch { /* 进程已经退出。 */ } }
    else child.kill("SIGTERM");
  };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Grok ACP call timed out")), input.timeoutMs ?? 300_000);
  const signal = input.call.signal ? AbortSignal.any([input.call.signal, timeout.signal]) : timeout.signal;
  const onAbort = () => terminate();
  signal.addEventListener("abort", onAbort, { once: true });
  let permissionFailure: PermissionRequiredError | undefined;
  const tools = createGrokAcpToolTracker();
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const sink = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream = acp.ndJsonStream(sink, output);
  const messages: string[] = [];
  let message = "";
  let messageId: string | null | undefined;
  const flushMessage = () => { if (message.trim()) messages.push(message.trim()); message = ""; messageId = undefined; };
  try {
    return await acp.client({ name: "runharness" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const action = providerToolPermissionAction(params.toolCall);
        const baseDecision = input.call.permission
          ? evaluatePermission(input.call.permission.policy, action)
          : { decision: "ask", source: "provider", reason: "The Provider requested approval" } as const;
        const decision = input.call.permission
          ? await input.call.permission.decide(action, baseDecision)
          : baseDecision;
        await input.call.onActivity?.({ kind: "message", backend: "grok", ...(input.call.model ? { model: input.call.model } : {}), phase: "status", summary: `permission ${decision.decision}: ${action.summary}` });
        if (decision.decision === "ask") {
          permissionFailure = new PermissionRequiredError(action, decision);
          return { outcome: { outcome: "cancelled" } };
        }
        const option = params.options.find((item) => item.kind === (decision.decision === "allow" ? "allow_once" : "reject_once"));
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
      })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        await publishGrokAcpUpdate(input.call, params.update, tools);
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          if (message && params.update.messageId !== messageId) flushMessage();
          messageId = params.update.messageId;
          message += params.update.content.text;
        } else if (params.update.sessionUpdate === "tool_call") flushMessage();
      })
      .connectWith(stream, async (agent) => {
        await agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "runharness", version: "0.1.0" },
          _meta: { clientType: "runharness", clientVersion: "0.1.0", rules: input.systemRules },
        }, { cancellationSignal: signal });
        const policy = input.call.options?.executionPolicy as ExecutionPolicy | undefined;
        const additionalDirectories = [...new Set([
          ...(input.call.writableRoots ?? []),
          ...(input.call.context ? [path.dirname(input.call.context.filePath)] : []),
        ])];
        const sessionMeta = {
          sessionId: input.providerSessionId,
          ...(input.call.model ? { modelId: input.call.model } : {}),
          yoloMode: Boolean(!input.call.permission && policy?.approvalMode === "allow_all" && policy.customRules.length === 0),
          autoMode: false,
        };
        if (input.resume) {
          await agent.request(acp.methods.agent.session.load, {
            sessionId: input.providerSessionId,
            cwd: input.call.cwd,
            additionalDirectories,
            mcpServers: [],
            _meta: sessionMeta,
          }, { cancellationSignal: signal });
        } else {
          const created = await agent.request(acp.methods.agent.session.new, {
            cwd: input.call.cwd,
            additionalDirectories,
            mcpServers: [],
            _meta: sessionMeta,
          }, { cancellationSignal: signal });
          if (created.sessionId !== input.providerSessionId) throw new Error(`Grok created unexpected ACP session '${created.sessionId}'`);
        }
        const prompt: acp.ContentBlock[] = [{ type: "text", text: input.call.prompt }];
        for (const image of input.call.images ?? []) prompt.push({ type: "image", data: (await readFile(image.filePath)).toString("base64"), mimeType: image.mediaType, uri: `file://${image.filePath}` });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: input.providerSessionId,
          prompt,
          _meta: { promptId: crypto.randomUUID() },
        }, { cancellationSignal: signal });
        flushMessage();
        if (permissionFailure) throw permissionFailure;
        if (response.stopReason !== "end_turn") throw new Error(`Grok ACP turn ended with ${response.stopReason}`);
        return {
          text: messages.at(-1) ?? "",
          sessionId: input.providerSessionId,
          stopReason: response.stopReason,
          ...(response.usage !== undefined ? { usage: response.usage } : {}),
          stderr: stderr.trim(),
          durationMs: Date.now() - started,
        };
      });
  } catch (error) {
    if (permissionFailure) throw permissionFailure;
    if (signal.aborted) {
      const aborted = new Error(input.call.signal?.aborted ? "Run interrupted" : "Grok ACP call timed out");
      aborted.name = "AbortError";
      throw aborted;
    }
    throw new Error(`Grok ACP transport failed: ${error instanceof Error ? error.message : String(error)}${stderr.trim() ? ` (${stderr.trim().slice(-2_000)})` : ""}`, { cause: error });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    terminate();
  }
}

export interface GrokAcpToolTracker {
  names: Map<string, string>;
  pendingResults: Map<string, Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>>;
  publishedCalls: Set<string>;
  publishedResults: Set<string>;
}

export function createGrokAcpToolTracker(): GrokAcpToolTracker {
  return { names: new Map(), pendingResults: new Map(), publishedCalls: new Set(), publishedResults: new Set() };
}

export async function publishGrokAcpUpdate(call: AgentCall, update: acp.SessionUpdate, tools: GrokAcpToolTracker): Promise<void> {
  const base = { backend: "grok", ...(call.model ? { model: call.model } : {}) };
  if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
    await call.onActivity?.({ kind: "message", ...base, phase: "thinking", summary: update.content.text });
    return;
  }
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    await call.onActivity?.({ kind: "message", ...base, phase: "text", summary: update.content.text });
    return;
  }
  if (update.sessionUpdate === "tool_call") {
    if (tools.publishedCalls.has(update.toolCallId)) return;
    tools.publishedCalls.add(update.toolCallId);
    const tool = effectiveGrokToolName(update) ?? update.title;
    tools.names.set(update.toolCallId, tool);
    await call.onActivity?.({ kind: "tool_call", ...base, tool, callId: update.toolCallId, summary: toolSummary({ ...update, title: tool }) });
    const pendingResult = tools.pendingResults.get(update.toolCallId);
    if (pendingResult) {
      tools.pendingResults.delete(update.toolCallId);
      await publishGrokAcpUpdate(call, pendingResult, tools);
    }
    return;
  }
  if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
    if (tools.publishedResults.has(update.toolCallId)) return;
    // Grok 允许完成通知先于基础调用到达；延迟发布可维持统一的 call → result 事件顺序。
    if (!tools.names.has(update.toolCallId)) {
      tools.pendingResults.set(update.toolCallId, update);
      return;
    }
    const tool = effectiveGrokToolName(update) ?? tools.names.get(update.toolCallId) ?? update.title ?? undefined;
    tools.names.delete(update.toolCallId);
    tools.publishedResults.add(update.toolCallId);
    await call.onActivity?.({ kind: "tool_result", ...base, ...(tool ? { tool } : {}), callId: update.toolCallId, summary: toolSummary({ ...update, ...(tool ? { title: tool } : {}) }), success: update.status === "completed" });
  }
}

/**
 * 将 Grok concise-tool 协议中的元工具还原为真实工具名。
 *
 * ACP 的 `title` 可能只是 `use_tool` 一类可配置入口；真正的 MCP 身份位于
 * `rawInput.tool_name`，完成结果还会把 server/tool 分开放在 `rawOutput` 中。
 * 该差异必须在 Provider 边界消化，后续编排层才能只依赖统一的 `server__tool` 名称。
 */
export function effectiveGrokToolName(input: { title?: string | null; rawInput?: unknown; rawOutput?: unknown }): string | undefined {
  const output = objectRecord(input.rawOutput);
  const outputTool = recordString(output, "tool_name", "toolName");
  const outputServer = recordString(output, "server_name", "serverName");
  if (outputTool) return qualifyMcpTool(outputServer, outputTool);

  const rawInput = objectRecord(input.rawInput);
  const inputTool = recordString(rawInput, "tool_name", "toolName");
  const inputServer = recordString(rawInput, "server_name", "serverName");
  const isMetaCall = inputTool && ("tool_input" in rawInput || "toolInput" in rawInput || input.title === "use_tool");
  if (isMetaCall) return qualifyMcpTool(inputServer, inputTool);
  return input.title ?? undefined;
}

function qualifyMcpTool(server: string | undefined, tool: string): string {
  if (!server || tool.includes("__")) return tool;
  return `${server}__${tool}`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key];
  return undefined;
}

function toolSummary(update: { title?: string | null; rawInput?: unknown; rawOutput?: unknown }): string {
  const raw = update.rawOutput ?? update.rawInput;
  if (raw === undefined) return update.title ?? "tool";
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const detail = typeof raw === "string" ? raw
    : typeof record?.output_for_prompt === "string" ? record.output_for_prompt
      : typeof record?.output === "string" ? record.output
        : JSON.stringify(raw);
  return `${update.title ?? "tool"}: ${detail}`.slice(0, 4_000);
}
