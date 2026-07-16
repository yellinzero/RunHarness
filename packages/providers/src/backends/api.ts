import type { ApiBackendConfig } from "@runharness/shared";
import { readFile } from "node:fs/promises";
import { type AgentBackend, type AgentCall, type AgentResponse, BackendUnavailableError } from "../runtime/backend.js";
import { McpToolSession } from "../tools/mcp.js";

/**
 * 为没有原生 coding CLI 的模型提供最小 Agent loop。
 * 模型负责决定是否调用工具，RunHarness 负责执行受控 MCP、回传结果，并限制最多 12 个工具回合。
 */
export class ApiAgentBackend implements AgentBackend {
  readonly kind = "api" as const;
  constructor(readonly id: string, private readonly config: ApiBackendConfig) {}
  async available(): Promise<boolean> { return Boolean(process.env[this.config.apiKeyEnv]); }
  capabilities() { return { imageInput: true, sessionResume: false, streamingActivity: true, networkAccess: true }; }

  async complete(call: AgentCall): Promise<AgentResponse> {
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) throw new BackendUnavailableError(this.id, `Environment variable ${this.config.apiKeyEnv} is required`);
    if (!call.model) throw new Error(`Agent using API backend '${this.id}' must configure a model`);
    const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 300_000);
    const abort = () => controller.abort(); call.signal?.addEventListener("abort", abort, { once: true });
    let mcp: McpToolSession | undefined;
    try {
      mcp = await McpToolSession.open(call.mcpServers, call.cwd);
      const response = this.config.protocol === "anthropic" ? await this.callAnthropic(call, apiKey, controller.signal, mcp) : await this.callOpenAi(call, apiKey, controller.signal, mcp);
      return { text: response.text, backend: this.id, model: call.model, durationMs: Date.now() - started, metadata: response.metadata };
    } finally { await mcp?.close(); clearTimeout(timer); call.signal?.removeEventListener("abort", abort); }
  }

  private async callAnthropic(call: AgentCall, apiKey: string, signal: AbortSignal, mcp: McpToolSession) {
    const images = await this.imageData(call);
    const content = [
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text: call.prompt },
    ];
    const messages: Array<Record<string, unknown>> = [{ role: "user", content }];
    let usage: unknown;
    for (let turn = 0; turn < 12; turn += 1) {
      const response = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...this.config.headers }, body: JSON.stringify({ model: call.model, max_tokens: Number(call.options?.maxOutputTokens ?? 8192), system: call.systemPrompt, messages, ...(mcp.tools.length ? { tools: mcp.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) }) });
      if (!response.ok) throw new Error(`Anthropic API ${response.status}: request failed`);
      const data = await response.json() as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; usage?: unknown };
      usage = data.usage;
      const text = data.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
      if (text) await call.onActivity?.({ kind: "message", backend: this.id, ...(call.model ? { model: call.model } : {}), phase: "text", summary: text.slice(0, 240) });
      const calls = data.content.filter((item) => item.type === "tool_use" && item.id && item.name);
      if (!calls.length) return { text, metadata: { usage } };
      messages.push({ role: "assistant", content: data.content });
      const results = [];
      for (const item of calls) {
        const result = await this.callMcpTool(call, mcp, item.name!, item.id!, item.input ?? {}, JSON.stringify(item.input ?? {}));
        results.push({ type: "tool_result", tool_use_id: item.id, content: result.output, is_error: result.isError });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("Anthropic API exceeded 12 MCP tool turns");
  }

  private async callOpenAi(call: AgentCall, apiKey: string, signal: AbortSignal, mcp: McpToolSession) {
    const images = await this.imageData(call);
    const content = [
      ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
      { type: "text", text: call.prompt },
    ];
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: call.systemPrompt }, { role: "user", content }];
    let usage: unknown;
    for (let turn = 0; turn < 12; turn += 1) {
      const response = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...this.config.headers }, body: JSON.stringify({ model: call.model, messages, temperature: call.options?.temperature ?? 0.2, ...(mcp.tools.length ? { tools: mcp.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) }) });
      if (!response.ok) throw new Error(`OpenAI-compatible API ${response.status}: request failed`);
      const data = await response.json() as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } }>; usage?: unknown };
      usage = data.usage;
      const message = data.choices[0]?.message;
      if (!message) throw new Error("OpenAI-compatible API returned no message");
      if (message.content?.trim()) await call.onActivity?.({ kind: "message", backend: this.id, ...(call.model ? { model: call.model } : {}), phase: "text", summary: message.content.slice(0, 240) });
      const calls = message.tool_calls ?? [];
      if (!calls.length) return { text: message.content ?? "", metadata: { usage } };
      messages.push({ role: "assistant", content: message.content, tool_calls: calls });
      for (const item of calls) {
        const input = parseToolInput(item.function.arguments, item.function.name);
        const result = await this.callMcpTool(call, mcp, item.function.name, item.id, input, item.function.arguments);
        messages.push({ role: "tool", tool_call_id: item.id, content: result.output });
      }
    }
    throw new Error("OpenAI-compatible API exceeded 12 MCP tool turns");
  }

  private async callMcpTool(call: AgentCall, mcp: McpToolSession, name: string, callId: string, input: Record<string, unknown>, summary: string) {
    const activity = { backend: this.id, ...(call.model ? { model: call.model } : {}), tool: name, callId, execution: { owner: "runharness" as const, placement: "host" as const, runtimeId: "project-mcp", controlled: true } };
    await call.onActivity?.({ kind: "tool_call", ...activity, summary: summary.slice(0, 180) });
    try {
      const result = await mcp.call(name, input, call.permission);
      await call.onActivity?.({ kind: "tool_result", ...activity, summary: result.output.slice(0, 180), success: !result.isError });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await call.onActivity?.({ kind: "tool_result", ...activity, summary: message.slice(0, 180), success: false });
      throw error;
    }
  }

  private async imageData(call: AgentCall) {
    return Promise.all((call.images ?? []).map(async (image) => ({
      mediaType: image.mediaType,
      data: (await readFile(image.filePath)).toString("base64"),
    })));
  }
}

function parseToolInput(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* 在下方统一转换为稳定且保留原因的 Provider 错误。 */ }
  throw new Error(`MCP tool '${name}' received invalid JSON arguments`);
}
