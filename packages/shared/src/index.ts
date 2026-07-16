/** Runtime、客户端、存储与 Agent 适配器共同依赖的稳定契约。 */
export type Actor = "planner" | "generator" | "evaluator" | "safety" | "human" | "system";

export type EventType =
  | "session_started"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_stopped"
  | "iteration_started"
  | "iteration_completed"
  | "agent_started"
  | "agent_completed"
  | "agent_failed"
  | "message"
  | "tool_call"
  | "tool_result"
  | "verdict"
  | "handoff"
  | "prompt_snapshot"
  | "context"
  | "plan_proposed"
  | "plan_approved"
  | "plan_rejected"
  | "approval_requested"
  | "approval_decided"
  | "steer_requested"
  | "workspace_checkpoint"
  | "delivery_started"
  | "delivery_completed"
  | "delivery_conflict"
  | "human_reviewed";

export interface HarnessEvent<T = unknown> {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  actor: Actor;
  type: EventType;
  payload: T;
}

export type SessionStatus = "idle" | "running" | "waiting_for_plan_approval" | "waiting_for_permission" | "completed" | "failed" | "stopped";

export interface SessionRecord {
  id: string;
  goal: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  runCount: number;
  latestRunId: string;
  parentSessionId?: string;
  activeRunId?: string;
  workspacePlacement: WorkspacePlacement;
  workspaceAccess: WorkspaceAccess;
  deliveryStatus: "live" | "pending" | "applied" | "discarded" | "conflict";
}

/** 选出描述 Session 当前 Run 的事件，同时保留完整事件供历史视图使用。 */
export function eventsForLatestRun(events: HarnessEvent[], latestRunId?: string): HarnessEvent[] {
  const runId = latestRunId
    ?? [...events].reverse().find((event) => event.type === "run_started")?.runId
    ?? events.at(-1)?.runId;
  return runId ? events.filter((event) => event.runId === runId) : [];
}

export interface RunRecord {
  id: string;
  sessionId: string;
  message: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  iterationCount: number;
}

export const DEFAULT_MAX_ITERATIONS = 3;
export const MAX_ITERATIONS_LIMIT = 20;

export interface RuntimeSettings {
  revision: number;
  maxIterations: number;
  planReview: "auto" | "require_approval";
  executionPolicy: ExecutionPolicy;
  safetyClassifier: SafetyClassifierConfig;
}

export function validateMaxIterations(value: unknown): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > MAX_ITERATIONS_LIMIT)
    throw new Error(`Iterations must be an integer from 1 to ${MAX_ITERATIONS_LIMIT}`);
  return Number(parsed);
}

export type PromptScope = "system" | "user";
export type PromptRole = "planner" | "generator" | "evaluator" | "safety_classifier";
export type PromptActivationNode = "planner_plan" | "generator_iteration" | "evaluator_review" | "safety_classification";

export interface PromptApplication {
  node: PromptActivationNode;
  channel: "system_prompt" | "user_context";
}

export interface PromptVersion {
  version: number;
  content: string;
  createdAt: string;
  reason: string;
}

export interface PromptSlot {
  key: string;
  scope: PromptScope;
  roles: PromptRole[];
  applications: PromptApplication[];
  description: string;
  editable: boolean;
  currentVersion: number;
  history: PromptVersion[];
}

export interface PromptSnapshot {
  runId: string;
  role: PromptRole;
  systemVersions: Record<string, number>;
  slotVersions: Record<string, number>;
  systemPrompt: string;
  userContext: string;
  createdAt: string;
}

export interface HandRequest {
  name: string;
  input: Record<string, unknown>;
}

export interface HandResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export type AgentRole = "planner" | "generator" | "evaluator";
export type BackendKind = "cli" | "api" | "test";

export type PermissionDecisionKind = "allow" | "ask" | "deny";
export type ApprovalMode = "allow_all" | "dangerous_only";
export type PermissionRuleScope = "command" | "path" | "origin" | "mcp_tool" | "action";

export type BuiltinPermissionCatalogId =
  | "destructive_changes"
  | "credential_access"
  | "external_network"
  | "mcp_side_effects"
  | "reversible_development";

export interface BuiltinPermissionCatalogEntry {
  id: BuiltinPermissionCatalogId;
  decision: "allow" | "ask";
  examples: string[];
}

export interface PermissionRule {
  id: string;
  scope: PermissionRuleScope;
  pattern: string;
  decision: PermissionDecisionKind;
  description?: string;
}

export interface ExecutionPolicy {
  workspace: {
    placement: WorkspacePlacement;
    access: WorkspaceAccess;
    materializeIgnored: string[];
  };
  network: "deny" | "allow_declared" | "allow_all";
  approvalMode: ApprovalMode;
  customRules: PermissionRule[];
}

export interface SafetyClassifierConfig {
  enabled: boolean;
  agentId?: string;
  fallback: "use_base_policy" | "ask";
}

export interface PermissionAction {
  kind: "command" | "file" | "network" | "mcp" | "git" | "deployment" | "other";
  summary: string;
  command?: string;
  path?: string;
  origin?: string;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface PermissionDecision {
  decision: PermissionDecisionKind;
  source: "builtin" | "custom_rule" | "safety_classifier" | "human" | "provider";
  reason: string;
  ruleId?: string;
  category?: "credentials" | "data_exfiltration" | "destructive" | "external_write" | "shared_resource" | "production" | "unknown";
}

export interface SafetyClassification extends PermissionDecision {
  source: "safety_classifier";
  safeAlternative?: string;
}

export interface EffectiveExecutionPolicy {
  requested: ExecutionPolicy;
  provider: string;
  supported: boolean;
  limitations: string[];
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  action: PermissionAction;
  baseDecision: PermissionDecision;
  classifierDecision?: SafetyClassification;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  decision: "approve" | "reject";
  scope: "once" | "session" | "project";
  actor: "human" | "system";
  reason?: string;
  createdAt: string;
}

export interface AgentDefinition {
  id: string;
  backend: BackendConfig;
  model?: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}

export interface AgentStatus extends AgentDefinition {
  available: boolean;
  stages: AgentRole[];
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  imageInput: boolean;
  sessionResume: boolean;
  streamingActivity: boolean;
  networkAccess: boolean;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  contextWindowTokens?: number;
}

export interface AgentModelDiscovery {
  agentId: string;
  available: boolean;
  models: DiscoveredModel[];
  defaultModel?: string;
  source: "client" | "configured" | "unavailable";
}

export interface CliBackendConfig {
  type: "cli";
  command: "claude" | "codex" | "grok" | string;
  executable?: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
}

export interface HttpMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
  command?: never;
}

/** 项目持有的 MCP Server 定义，由所有 Agent backend 共享。 */
export type McpServerConfig = (StdioMcpServerConfig | HttpMcpServerConfig) & {
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
};

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  available: boolean;
  tools: Array<{ name: string; description?: string }>;
  unknownDisabledTools?: string[];
  error?: string;
}

export interface ApiBackendConfig {
  type: "api";
  protocol: "anthropic" | "openai-compatible";
  baseUrl?: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type BackendConfig = CliBackendConfig | ApiBackendConfig;

export interface ModelRoutingConfig {
  agents: AgentDefinition[];
  stages: Record<AgentRole, string[]>;
  mcpServers?: Record<string, McpServerConfig>;
  acceptance?: AcceptanceSpec[];
}

export type ExecutionOwner = "runharness" | "provider" | "external";
export type ExecutionPlacement = "host" | "provider_sandbox" | "container" | "vm" | "device" | "remote" | "unknown";
export type EvidenceStatus = "started" | "passed" | "failed" | "unavailable" | "denied" | "cancelled";
export type EvidenceFailureCategory = "assertion" | "process_launch" | "sandbox" | "permission" | "transport" | "timeout" | "missing_dependency" | "cancelled" | "unknown";

export interface RuntimeDescriptor {
  id: string;
  label: string;
  owner: ExecutionOwner;
  placement: ExecutionPlacement;
  capabilities: string[];
  controlled: boolean;
  detail: string;
  limitations: string[];
}

export interface CapabilitySnapshot {
  agents: Array<{ id: string; backend: string; capabilities: AgentCapabilities }>;
  runtimes: RuntimeDescriptor[];
  acceptance: AcceptanceSpec[];
}

export interface ArtifactReference {
  name: string;
  path: string;
  mediaType?: string;
}

export interface EvidenceRecord {
  id: string;
  source: "agent" | "configured_acceptance" | "evaluator" | "human";
  owner: ExecutionOwner;
  runtimeId?: string;
  placement: ExecutionPlacement;
  capability: string;
  requirement: "required" | "optional" | "exploratory";
  status: EvidenceStatus;
  failureCategory?: EvidenceFailureCategory;
  blocksCompletion: boolean;
  summary: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifacts: ArtifactReference[];
  native?: unknown;
}

interface AcceptanceBase {
  name: string;
  runtime: string;
  required: boolean;
  timeoutMs?: number;
}

export type AcceptanceSpec =
  | (AcceptanceBase & { kind: "command"; command: string })
  | (AcceptanceBase & { kind: "tool"; tool: string; input: Record<string, unknown> })
  | (AcceptanceBase & { kind: "scenario"; scenario: string; input?: Record<string, unknown> });

export interface ChangeSet {
  workspace: string;
  status: string;
  diff: string;
  changedFiles: string[];
  deletedFiles: string[];
}

export type WorkspacePlacement = "in_place" | "isolated";
export type WorkspaceAccess = "read_write" | "read_only";
export type WorkspaceState = "preparing" | "ready" | "retained" | "delivering" | "removed" | "missing" | "quarantined";

export interface SessionWorkspaceRecord {
  sessionId: string;
  placement: WorkspacePlacement;
  access: WorkspaceAccess;
  sourceRoot: string;
  repository: string;
  baselineCommit: string;
  primaryPath?: string;
  auxiliaryRoot?: string;
  auxiliaryWorktrees: AuxiliaryWorktreeState[];
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
}

export type ExplanationTopic = "workspace" | "delivery" | "steer" | "permission" | "evidence";
export interface ConceptExplanation {
  topic: ExplanationTopic;
  title: string;
  summary: string;
  why: string;
  changes: string;
  remains: string;
  actions: string[];
  learnTopic: "harness-design" | "auto-mode" | "managed-agents" | "long-running";
}

/** 根据当前状态确定性生成的 Harness 解释，不调用 Agent、不消耗 token。 */
export function explainSessionState(topic: ExplanationTopic, session?: SessionRecord, result?: DevelopmentRunResult, locale: "en" | "zh" = "en"): ConceptExplanation {
  if (locale === "zh") return explainSessionStateZh(topic, session, result);
  if (topic === "workspace") {
    const isolated = (session?.workspacePlacement ?? result?.placement ?? "in_place") === "isolated";
    const readOnly = session?.workspaceAccess === "read_only";
    return { topic, title: "Workspace boundary", summary: isolated ? "This Session works in an isolated primary worktree." : "This Session edits the live project in place.", why: isolated ? "Isolation keeps Agent changes inspectable until you explicitly deliver or discard them." : "In-place work keeps the shortest development path; changes are visible in the project immediately.", changes: readOnly ? "All Agent roles may inspect files but Provider write operations are restricted." : "Planner, Generator, and Evaluator receive the same writable workspace boundary.", remains: isolated ? "The primary and unresolved auxiliary worktrees remain until Apply, Discard, or Session deletion." : "No persistent RunHarness worktree is retained.", actions: isolated ? ["Continue in the same worktree", "Apply after inspection", "Discard the isolated work"] : ["Continue editing the live project", "Inspect the recorded baseline diff"], learnTopic: "managed-agents" };
  }
  if (topic === "delivery") {
    const status = session?.deliveryStatus ?? result?.delivery.status ?? (result?.placement === "in_place" ? "live" : "pending");
    return { topic, title: "Result delivery", summary: `Delivery is ${status}.`, why: result?.placement === "isolated" ? "Run completion is evidence, not permission to modify the source project. Apply is therefore explicit." : "In-place changes already exist in the source project and need no Apply step.", changes: result?.placement === "isolated" ? "Apply compares baseline, primary worktree, and current source before copying the file delta." : "No additional delivery mutation occurs.", remains: "Session events, evidence, Review, and result artifacts remain after delivery cleanup.", actions: status === "pending" ? ["Inspect changed files and evidence", "Apply", "Discard", "Continue before delivery"] : ["Review the delivery event", "Start a linked Session for further work"], learnTopic: "harness-design" };
  }
  if (topic === "steer") return { topic, title: "Steering", summary: "Steer supplements the current Session and replans immediately.", why: "A new requirement may invalidate the active Plan while the existing workspace progress is still valuable.", changes: "The active Run is checkpointed and stopped; a new Run invokes Planner with the added instruction.", remains: "The original goal, prior additions, files, baseline, evidence, and Session identity remain.", actions: ["Use /steer MESSAGE during an active Run", "Use ordinary input to queue work until the Run ends"], learnTopic: "managed-agents" };
  if (topic === "permission") return { topic, title: "Permission boundary", summary: "Workspace, network, approvals, and Provider sandbox are independent controls.", why: "A Harness should preserve Agent capability while making real side effects and security boundaries explicit.", changes: "A permission decision may allow, ask, or deny one action without widening unrelated boundaries.", remains: "The decision and its reason remain in the Session event history.", actions: ["Inspect the matched rule and Provider boundary", "Approve once/session/project or reject"], learnTopic: "auto-mode" };
  return { topic, title: "Evidence", summary: "Evidence records what was tested, where it ran, and whether it blocks completion.", why: "Assertion failures, sandbox denials, missing infrastructure, and cancellations require different recovery actions.", changes: "Viewing evidence does not run a model or repeat the action.", remains: "Native tool payloads and artifacts remain linked from the Session.", actions: ["Inspect blocking evidence", "Open the execution event", "Continue when more evidence is required"], learnTopic: "long-running" };
}

function explainSessionStateZh(topic: ExplanationTopic, session?: SessionRecord, result?: DevelopmentRunResult): ConceptExplanation {
  if (topic === "workspace") {
    const isolated = (session?.workspacePlacement ?? result?.placement ?? "in_place") === "isolated";
    const readOnly = session?.workspaceAccess === "read_only";
    return { topic, title: "工作区边界", summary: isolated ? "这个 Session 在隔离的 primary worktree 中工作。" : "这个 Session 直接修改当前项目。", why: isolated ? "隔离让 Agent 修改在明确交付或丢弃前保持可检查。" : "In-place 保留最短开发路径，修改会立即出现在项目中。", changes: readOnly ? "所有 Agent 角色都可检查文件，但 Provider 写操作受到限制。" : "Planner、Generator 和 Evaluator 使用同一个可写工作区边界。", remains: isolated ? "primary 和未处理的辅助 worktree 会保留到 Apply、Discard 或删除 Session。" : "不会保留持久的 RunHarness worktree。", actions: isolated ? ["在同一 worktree 继续", "检查后 Apply", "丢弃隔离修改"] : ["继续修改当前项目", "检查记录的 baseline diff"], learnTopic: "managed-agents" };
  }
  if (topic === "delivery") {
    const status = session?.deliveryStatus ?? result?.delivery.status ?? (result?.placement === "in_place" ? "live" : "pending");
    return { topic, title: "结果交付", summary: `当前交付状态：${status}。`, why: result?.placement === "isolated" ? "Run 完成只代表已有证据，不代表已获准修改源项目，因此 Apply 必须显式执行。" : "In-place 修改已经位于源项目中，不需要 Apply。", changes: result?.placement === "isolated" ? "Apply 会比较 baseline、primary worktree 和当前源项目，再交付文件差异。" : "不会发生额外交付写入。", remains: "清理工作区后，Session 事件、证据、Review 和结果仍会保留。", actions: status === "pending" ? ["检查文件和证据", "Apply", "Discard", "交付前继续"] : ["检查交付事件", "需要继续时创建关联 Session"], learnTopic: "harness-design" };
  }
  if (topic === "steer") return { topic, title: "插队调整", summary: "Steer 会补充当前 Session 的要求并立即重新规划。", why: "新要求可能让当前 Plan 失效，但已有工作区进度仍有价值。", changes: "当前 Run 会保存 checkpoint 并停止，新 Run 带着补充要求调用 Planner。", remains: "原始目标、历史补充、文件、baseline、证据和 Session 身份都会保留。", actions: ["运行中使用 /steer MESSAGE", "普通输入继续排队到 Run 结束"], learnTopic: "managed-agents" };
  if (topic === "permission") return { topic, title: "权限边界", summary: "工作区、网络、审批和 Provider sandbox 是彼此独立的控制。", why: "Harness 应保留 Agent 能力，同时明确真实副作用和安全边界。", changes: "一次权限决定只允许、询问或拒绝对应动作，不会扩大其他边界。", remains: "决定和原因会保留在 Session 事件历史中。", actions: ["检查命中的规则和 Provider 边界", "按一次、Session、项目批准或拒绝"], learnTopic: "auto-mode" };
  return { topic, title: "证据", summary: "证据记录测试了什么、在哪里执行以及是否阻塞完成。", why: "断言失败、sandbox 拒绝、基础设施缺失和取消需要不同的恢复方式。", changes: "查看证据不会调用模型，也不会重新执行动作。", remains: "原生工具数据和产物仍与 Session 关联。", actions: ["检查阻塞证据", "打开执行事件", "需要更多证据时继续"], learnTopic: "long-running" };
}

export interface AuxiliaryWorktreeState {
  path: string;
  head: string;
  branch?: string;
  dirty: boolean;
  integratedIntoPrimary: boolean;
  ownership: "session" | "external";
}

export interface DevelopmentReview {
  reviewer: string;
  decision: "accept" | "request_changes" | "unavailable";
  text: string;
  status?: "completed" | "control_missing";
}

export interface DevelopmentPlan {
  version: number;
  text: string;
  status: "proposed" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface HumanReviewDecision {
  eventId: string;
  decision: "accept" | "reject" | "add_evidence";
  reason: string;
  createdAt: string;
}

export interface DevelopmentRunResult {
  sessionId: string;
  runId: string;
  workspace: string;
  placement: WorkspacePlacement;
  iterations: number;
  completed: boolean;
  changes: ChangeSet;
  evidence: EvidenceRecord[];
  reviews: DevelopmentReview[];
  plan?: DevelopmentPlan;
  pendingApproval?: ApprovalRequest;
  reviewStatus?: "completed" | "pending";
  /** 当前 workspace 世代中所有 Run 共同使用的不可变 Git 基线提交。 */
  baselineCommit: string;
  /** 由 Runtime 持有、保存基线提交的 Git 仓库。 */
  baselineRepository: string;
  /** in-place 执行或 isolated 交付所对应的真实项目根目录。 */
  sourceRoot: string;
  delivery: {
    status: "pending" | "applied" | "discarded";
    updatedAt?: string;
    files?: string[];
  };
}

export interface PlanDecisionRequest {
  version: number;
  decision: "approve" | "revise" | "reject";
  revisedPlan?: string;
  reason?: string;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  size: number;
}

export interface UploadImageAttachmentRequest {
  name: string;
  data: string;
}

export interface StartSessionRequest {
  goal: string;
  parentSessionId?: string;
  attachmentIds?: string[];
  placement?: WorkspacePlacement;
  source?: string;
  maxIterations?: number;
}

export interface StartRunRequest {
  message: string;
  attachmentIds?: string[];
  selectedAttachmentIds?: string[];
  maxIterations?: number;
  /** 明确允许本次 Run 的可写 Agent 调用访问网络。 */
  allowNetwork?: boolean;
}

export interface StartSessionResponse {
  sessionId: string;
  runId: string;
  status: "running" | "failed";
  streamUrl: string;
  attachments?: ImageAttachment[];
}

export interface StopSessionResponse {
  sessionId: string;
  status: SessionStatus;
}

export interface RuntimeRegistration {
  id: string;
  projectDir: string;
  projectName: string;
  url: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface DevelopmentConfig {
  acceptance: AcceptanceSpec[];
  mcpServers?: Record<string, McpServerConfig>;
  maxIterations: number;
  maxDiffChars: number;
}

export interface DashboardSnapshot {
  sessions: SessionRecord[];
  events: HarnessEvent[];
  prompts: PromptSlot[];
  agents: AgentStatus[];
}

export const defaultExecutionPolicy: ExecutionPolicy = {
  workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] },
  network: "allow_declared",
  approvalMode: "dangerous_only",
  customRules: [],
};

export const defaultRuntimeSettings: RuntimeSettings = {
  revision: 1,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  planReview: "auto",
  executionPolicy: defaultExecutionPolicy,
  safetyClassifier: { enabled: false, fallback: "use_base_policy" },
};

export function validateRuntimeSettings(value: unknown): asserts value is RuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime settings must be an object");
  const settings = value as Partial<RuntimeSettings>;
  if (!Number.isInteger(settings.revision) || Number(settings.revision) < 1) throw new Error("Runtime revision must be a positive integer");
  validateMaxIterations(settings.maxIterations);
  if (settings.planReview !== "auto" && settings.planReview !== "require_approval") throw new Error("planReview must be auto or require_approval");
  const policy = settings.executionPolicy;
  if (!policy || !policy.workspace || !["in_place", "isolated"].includes(policy.workspace.placement) || !["read_write", "read_only"].includes(policy.workspace.access) || !Array.isArray(policy.workspace.materializeIgnored)) throw new Error("Invalid workspace policy");
  for (const requested of policy.workspace.materializeIgnored) {
    if (typeof requested !== "string" || !requested.trim()) throw new Error("Ignored materialization paths must be non-empty strings");
    const normalized = requested.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Ignored materialization path escapes the project: ${requested}`);
  }
  if (!["deny", "allow_declared", "allow_all"].includes(policy.network)) throw new Error("Invalid network policy");
  if (!["allow_all", "dangerous_only"].includes(policy.approvalMode)) throw new Error("Invalid approval mode");
  if (!Array.isArray(policy.customRules)) throw new Error("customRules must be an array");
  const ids = new Set<string>();
  for (const rule of policy.customRules) {
    if (!rule?.id?.trim() || ids.has(rule.id)) throw new Error("Permission rules require unique IDs");
    ids.add(rule.id);
    if (!["command", "path", "origin", "mcp_tool", "action"].includes(rule.scope) || !rule.pattern?.trim() || !["allow", "ask", "deny"].includes(rule.decision))
      throw new Error(`Invalid permission rule '${rule.id}'`);
  }
  const classifier = settings.safetyClassifier;
  if (!classifier || typeof classifier.enabled !== "boolean" || !["use_base_policy", "ask"].includes(classifier.fallback)) throw new Error("Invalid Safety classifier configuration");
  if (classifier.enabled && !classifier.agentId?.trim()) throw new Error("An enabled Safety classifier requires one Agent");
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
