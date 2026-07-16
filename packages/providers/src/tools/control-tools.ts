import type { McpServerConfig } from "@runharness/shared";

export const CONTROL_SERVER_NAME = "runharness_control";

export type ReviewControlDecision = "accept" | "request_changes" | "unavailable";
export type SafetyControlDecision = "allow" | "ask" | "deny";
export type ControlToolFamily = "review" | "safety";

const reviewTools = [
  ["review_accept", "Mark the reviewed implementation as acceptable."],
  ["review_request_changes", "Request another implementation iteration after explaining the blocking evidence in your response."],
  ["review_unavailable", "Mark the review as inconclusive because the required evidence or capability is unavailable."],
] as const;

const safetyTools = [
  ["safety_allow", "Allow the proposed action under the supplied authorization and safety policy."],
  ["safety_ask", "Require explicit user approval before the proposed action."],
  ["safety_deny", "Deny the proposed action under the supplied authorization and safety policy."],
] as const;

function toolsFor(family: ControlToolFamily) {
  return family === "review" ? reviewTools : safetyTools;
}

function controlServerSource(family: ControlToolFamily): string {
  const tools = toolsFor(family);
  return `
import readline from "node:readline";
const tools = ${JSON.stringify(tools.map(([name, description]) => ({ name, description, inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })))};
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "runharness-control", version: "0.1.0" } } });
  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  if (request.method === "tools/call") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "RunHarness control signal recorded." }] } });
  if (request.method === "ping") return send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
});
`;
}

export function controlMcpServer(family: ControlToolFamily): McpServerConfig {
  const tools = toolsFor(family);
  return {
    command: process.execPath,
    args: ["--input-type=module", "--eval", controlServerSource(family)],
    enabledTools: tools.map(([name]) => name),
    startupTimeoutMs: 5_000,
    toolTimeoutMs: 5_000,
  };
}

/**
 * 给单次角色调用追加最小控制面 MCP；它只记录生命周期信号，不替代 Agent 的自然语言输出。
 * Review 与 Safety 使用不同工具族，避免模型看到与当前职责无关的控制动作。
 */
export function withControlMcp(servers: Record<string, McpServerConfig> | undefined, family: ControlToolFamily): Record<string, McpServerConfig> {
  return { ...servers, [CONTROL_SERVER_NAME]: controlMcpServer(family) };
}

export function reviewDecisionFromTool(tool: string | undefined): ReviewControlDecision | undefined {
  const name = normalizedToolName(tool);
  if (name === "review_accept") return "accept";
  if (name === "review_request_changes") return "request_changes";
  if (name === "review_unavailable") return "unavailable";
  return undefined;
}

export function safetyDecisionFromTool(tool: string | undefined): SafetyControlDecision | undefined {
  const name = normalizedToolName(tool);
  if (name === "safety_allow") return "allow";
  if (name === "safety_ask") return "ask";
  if (name === "safety_deny") return "deny";
  return undefined;
}

function normalizedToolName(tool: string | undefined): string {
  if (!tool || !tool.includes(CONTROL_SERVER_NAME)) return "";
  return tool.split(/__|\./).at(-1) ?? "";
}
