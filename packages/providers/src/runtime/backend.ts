import type { AgentCapabilities, ExecutionOwner, ExecutionPlacement, ExecutionPolicy, McpServerConfig, PermissionAction, PermissionDecision } from "@runharness/shared";

/** 一次有边界的 Agent 调用，包含工作区、工具、取消信号和过程事件出口。 */
export interface AgentCall {
  prompt: string;
  systemPrompt: string;
  model?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  writableRoots?: string[];
  role: string;
  images?: AgentImage[];
  mcpServers?: Record<string, McpServerConfig>;
  options?: Record<string, unknown>;
  permission?: {
    policy: ExecutionPolicy;
    /** 依次经过项目规则、安全判断和实时人工确认，决定一个具体动作是否可执行。 */
    decide(action: PermissionAction, baseDecision: PermissionDecision): Promise<PermissionDecision>;
  };
  signal?: AbortSignal;
  onActivity?: (activity: AgentActivity) => void | Promise<void>;
  context?: { filePath: string; summary: string };
  conversation?: {
    runHarnessSessionId: string;
    persist: boolean;
    providerSessionId?: string;
    resume?: boolean;
  };
}

/** Agent 执行期间产生的 Provider 无关活动，是 TUI、Web 和持久事件的共同输入。 */
export interface AgentActivity {
  /** `message` 覆盖所有角色的思考和正文过程，不只记录工具调用。 */
  kind: "agent_started" | "agent_completed" | "agent_failed" | "tool_call" | "tool_result" | "message";
  agentId?: string;
  backend: string;
  model?: string;
  tool?: string;
  callId?: string;
  summary?: string;
  /** 仅用于区分执行中的消息阶段。 */
  phase?: "thinking" | "text" | "status";
  durationMs?: number;
  success?: boolean;
  execution?: {
    owner: ExecutionOwner;
    placement: ExecutionPlacement;
    runtimeId?: string;
    controlled: boolean;
  };
}

export interface AgentImage {
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  filePath: string;
}

export interface AgentResponse {
  text: string;
  backend: string;
  model?: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

/** 适配一种模型传输协议，不参与 Planner、Generator、Evaluator 的编排决策。 */
export interface AgentBackend {
  readonly id: string;
  readonly kind: "cli" | "api" | "test";
  available(): Promise<boolean>;
  capabilities(): AgentCapabilities;
  /** 完成一次角色调用；失败时必须保留传输层或 Provider 的真实上下文。 */
  complete(call: AgentCall): Promise<AgentResponse>;
}

export class BackendUnavailableError extends Error {
  constructor(public readonly backendId: string, message: string) { super(message); this.name = "BackendUnavailableError"; }
}
