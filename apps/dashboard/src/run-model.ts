import type { DevelopmentReview, DevelopmentRunResult, EvidenceRecord, HarnessEvent, HumanReviewDecision } from "@runharness/shared";

export type WorkflowStage = "goal" | "planner" | "generator" | "evidence" | "evaluator" | "result";
export type StageState = "waiting" | "active" | "passed" | "pending" | "failed" | "stopped";

export interface RunReview extends DevelopmentReview {
  sourceEventId?: string;
  iteration?: number;
  humanDecision?: HumanReviewDecision["decision"];
}

export interface RunMetrics {
  totalMs: number;
  agentMs: number;
  checkMs: number;
  toolCalls: number;
  iterations: number;
}

export interface AgentPresence {
  role: string;
  agentId?: string;
  backend?: string;
  model?: string;
  iteration?: number;
}

export interface RunViewModel {
  stages: Record<WorkflowStage, StageState>;
  currentStage: WorkflowStage;
  metrics: RunMetrics;
  evidence: EvidenceRecord[];
  reviews: RunReview[];
  plan: string | undefined;
  generatorSummary: string | undefined;
  agents: AgentPresence[];
  live: LiveCursor;
}

export interface LiveCursor {
  stage: WorkflowStage;
  iteration?: number;
  maxIterations?: number;
  role?: string;
  agent?: string;
  model?: string;
  tool?: string;
  label: string;
}

export type FlowNodeKind = WorkflowStage;
export type FlowNodeState = StageState;

export interface ProcessFlowNode {
  id: string;
  kind: FlowNodeKind;
  state: FlowNodeState;
  detail?: string;
  active: boolean;
}

export interface ProcessFlowEdge {
  id: string;
  source: WorkflowStage;
  target: WorkflowStage;
  animated?: boolean;
  kind: "forward" | "loop" | "to-result";
  iteration?: number;
  maxIterations?: number;
  label?: string;
}

export interface ProcessFlowModel {
  nodes: ProcessFlowNode[];
  edges: ProcessFlowEdge[];
  liveNodeId: WorkflowStage;
  loop: { current: number; max: number };
}


export function buildRunView(events: HarnessEvent[], result?: DevelopmentRunResult): RunViewModel {
  const eventEvidence = currentIterationAcceptance(events);
  const evidence = eventEvidence.length ? eventEvidence : (result?.evidence ?? []);
  const humanDecisions = new Map(events.filter((event) => event.type === "human_reviewed").flatMap((event) => {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const eventId = payload ? readString(payload, "eventId") : "";
    const decision = payload && ["accept", "reject", "add_evidence"].includes(readString(payload, "decision")) ? readString(payload, "decision") as HumanReviewDecision["decision"] : undefined;
    return eventId && decision ? [[eventId, decision] as const] : [];
  }));
  const eventReviews = events.flatMap(readReview).map((review) => review.sourceEventId && humanDecisions.has(review.sourceEventId) ? { ...review, humanDecision: humanDecisions.get(review.sourceEventId) } : review);
  const reviews = eventReviews.length ? eventReviews : (result?.reviews ?? []);
  const iterations = Math.max(result?.iterations ?? 0, ...events.map(readIteration), 0);
  const terminal = effectiveTerminalEvent(events);
  const progress = deriveStageProgress(events, evidence, reviews, terminal?.type, result?.reviewStatus);
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const totalMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const agentMs = events.filter((event) => event.type === "agent_completed").reduce((sum, event) => sum + readNumber(event.payload, "durationMs"), 0);
  const checkMs = evidence.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const live = buildLiveCursor(events, progress.currentStage, terminal?.type);
  return {
    stages: progress.stages,
    currentStage: progress.currentStage,
    metrics: { totalMs, agentMs, checkMs, toolCalls: events.filter((event) => event.type === "tool_call").length, iterations },
    evidence,
    reviews,
    plan: events.filter((event) => event.type === "handoff" && event.actor === "planner").map((event) => humanizeAgentText(readString(event.payload, "plan"))).filter(Boolean).at(-1),
    generatorSummary: events.filter((event) => event.type === "handoff" && event.actor === "generator").map((event) => humanizeAgentText(readString(event.payload, "summary"))).filter(Boolean).at(-1),
    agents: collectAgents(events),
    live,
  };
}

function effectiveTerminalEvent(events: HarnessEvent[]): HarnessEvent | undefined {
  const terminal = findLast(events, (event) => ["run_completed", "run_failed", "run_stopped"].includes(event.type));
  if (!terminal) return undefined;
  const resumed = events.some((event) => event.sequence > terminal.sequence && [
    "iteration_started", "iteration_completed", "agent_started", "agent_completed", "agent_failed",
    "tool_call", "tool_result", "handoff", "verdict",
  ].includes(event.type));
  return resumed ? undefined : terminal;
}

/**
 * 从事件推导用于状态和恢复的内部路由进度，界面不把它描述成固定流水线。
 * 每个阶段只能处于 waiting、active、passed、failed、pending 或 stopped。
 */
export function deriveStageProgress(
  events: HarnessEvent[],
  evidence: EvidenceRecord[],
  reviews: RunReview[],
  terminalType?: string,
  reviewStatus?: DevelopmentRunResult["reviewStatus"],
): { stages: Record<WorkflowStage, StageState>; currentStage: WorkflowStage } {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const terminalOutcome: StageState | undefined = terminalType === "run_completed"
    ? reviewStatus === "pending" ? "pending" : "passed"
    : terminalType === "run_stopped" ? "stopped"
    : terminalType === "run_failed" ? "failed"
    : undefined;

  const planner = roleProgress(sorted, "planner");
  const generator = roleProgress(sorted, "generator");
  let evaluator = roleProgress(sorted, "evaluator");
  if (reviews.length) {
    const unresolvedServiceFailure = reviews.some((item) => (item.status === "control_missing" || item.decision === "unavailable") && item.humanDecision !== "accept");
    const unresolvedFinding = reviews.some((item) => item.status !== "control_missing" && item.decision === "request_changes" && item.humanDecision !== "reject");
    evaluator = { status: unresolvedServiceFailure ? "pending" : unresolvedFinding ? "failed" : "passed" };
  }
  const evidenceProgress = acceptanceProgress(sorted, evidence);
  // 实时事件压缩后，已持久化的验收证据仍是权威来源。
  const evidenceState = evidenceProgress.status === "waiting"
    ? evidence.length
      ? { status: (evidence.every((item) => item.status === "passed" || !item.blocksCompletion) ? "passed" : "failed") as StageState }
      : reviews.length || terminalType === "run_completed" ? { status: "passed" as StageState } : evidenceProgress
    : evidenceProgress;
  const started = sorted.some((event) => event.type === "session_started" || event.type === "run_started");

  // 判断当前阶段时，正在执行的角色优先于时间上更晚但已经完成的角色。
  let currentStage: WorkflowStage = "goal";
  if (terminalOutcome) currentStage = "result";
  else if (evaluator.status === "active") currentStage = "evaluator";
  else if (evidenceState.status === "active") currentStage = "evidence";
  else if (generator.status === "active") currentStage = "generator";
  else if (planner.status === "active") currentStage = "planner";
  else if (evaluator.status === "passed" || evaluator.status === "failed" || evaluator.status === "pending") currentStage = "evaluator";
  else if (evidenceState.status === "passed" || evidenceState.status === "failed") currentStage = "evidence";
  else if (generator.status === "passed" || generator.status === "failed") currentStage = "generator";
  else if (planner.status === "passed" || planner.status === "failed") currentStage = "planner";
  else if (started) currentStage = "goal";

  // Run 在阶段中途结束时，把终态归到被中断的阶段，避免界面仍显示运行中。
  const seal = (status: StageState, stage: WorkflowStage): StageState => {
    if (!terminalOutcome) return status;
    if (status === "active") return terminalOutcome === "passed" ? "passed" : terminalOutcome;
    if (status === "failed" && terminalOutcome === "stopped") return "stopped";
    if (status === "waiting" && stage === "result") return terminalOutcome;
    return status;
  };

  const stages: Record<WorkflowStage, StageState> = {
    goal: started || terminalOutcome ? "passed" : "active",
    planner: seal(planner.status, "planner"),
    generator: seal(generator.status, "generator"),
    evidence: seal(evidenceState.status, "evidence"),
    evaluator: seal(evaluator.status, "evaluator"),
    result: terminalOutcome ?? "waiting",
  };

  if (terminalOutcome) stages.result = terminalOutcome;
  return { stages, currentStage: terminalOutcome ? "result" : currentStage };
}

function roleProgress(events: HarnessEvent[], actor: "planner" | "generator" | "evaluator"): { status: StageState } {
  const relevant = events.filter((event) => event.actor === actor && (actor !== "generator" || !isAcceptanceTool(event)));
  if (!relevant.length) return { status: "waiting" };
  const failed = findLast(relevant, (event) => event.type === "agent_failed");
  const completed = findLast(relevant, (event) => actor === "evaluator" ? event.type === "verdict" : event.type === "handoff");
  const started = findLast(relevant, (event) => ["agent_started", "agent_completed", "tool_call", "tool_result", "message"].includes(event.type));
  if (failed && (!completed || failed.sequence > completed.sequence)) return { status: "failed" };
  if (started && (!completed || started.sequence > completed.sequence)) return { status: "active" };
  if (completed) {
    if (actor === "evaluator") {
      const verdict = findLast(relevant, (event) => event.type === "verdict");
      if (verdict && isRecord(verdict.payload)) {
        if (verdict.payload.status === "control_missing" || verdict.payload.decision === "unavailable") return { status: "pending" };
        if (verdict.payload.decision === "request_changes") return { status: "failed" };
      }
    }
    return { status: "passed" };
  }
  return { status: "waiting" };
}

function acceptanceProgress(events: HarnessEvent[], evidence: EvidenceRecord[]): { status: StageState } {
  const allCheckEvents = events.filter((event) => isAcceptanceTool(event));
  const currentIteration = Math.max(...allCheckEvents.map((event) => readNumber(event.payload, "iteration")), 0);
  const checkEvents = currentIteration > 0
    ? allCheckEvents.filter((event) => readNumber(event.payload, "iteration") === currentIteration)
    : allCheckEvents;
  if (!checkEvents.length && !evidence.length) return { status: "waiting" };
  const started = findLast(checkEvents, (event) => event.type === "tool_call");
  const finished = findLast(checkEvents, (event) => event.type === "tool_result");
  if (started && (!finished || started.sequence > finished.sequence)) return { status: "active" };
  if (evidence.length) return { status: evidence.every((item) => item.status === "passed" || !item.blocksCompletion) ? "passed" : "failed" };
  if (finished) return { status: "passed" };
  return { status: "waiting" };
}

export function collectAgents(events: HarnessEvent[]): AgentPresence[] {
  const seen = new Map<string, AgentPresence>();
  for (const event of events) {
    if (!["agent_started", "agent_completed", "agent_failed", "handoff", "tool_call"].includes(event.type)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const agentId = readString(payload, "agentId") || readString(payload, "backend") || undefined;
    const model = readString(payload, "model") || undefined;
    const iteration = readNumber(payload, "iteration") || undefined;
    const key = [event.actor, agentId, model, iteration ?? ""].join("|");
    if (!seen.has(key) && (agentId || model || event.actor !== "system")) {
      seen.set(key, {
        role: event.actor,
        ...(agentId ? { agentId } : {}),
        ...(readString(payload, "backend") ? { backend: readString(payload, "backend") } : {}),
        ...(model ? { model } : {}),
        ...(iteration ? { iteration } : {}),
      });
    }
  }
  return [...seen.values()];
}

export function buildLiveCursor(events: HarnessEvent[], stage: WorkflowStage, terminalType?: string): LiveCursor {
  if (terminalType === "run_completed") return { stage: "result", label: "completed" };
  if (terminalType === "run_failed") return { stage: "result", label: "failed" };
  if (terminalType === "run_stopped") return { stage: "result", label: "stopped" };
  const latest = findLast(events, (event) => [
    "agent_started", "agent_completed", "agent_failed", "tool_call", "tool_result", "message",
    "iteration_started", "handoff", "verdict", "run_started",
  ].includes(event.type));
  if (!latest) return { stage, label: "preparing" };
  const payload = isRecord(latest.payload) ? latest.payload : {};
  const iteration = readNumber(payload, "iteration") || latestIterationFrom(events) || undefined;
  const maxIterations = readNumber(payload, "maxIterations") || latestMaxIterationsFrom(events) || undefined;
  const agent = readString(payload, "agentId") || readString(payload, "backend") || undefined;
  const model = readString(payload, "model") || undefined;
  const tool = readString(payload, "tool") || readString(payload, "name") || undefined;
  const role = latest.actor;
  const phase = latest.type === "message" && readString(payload, "action") !== "stop_requested"
    ? (readString(payload, "phase") || "draft")
    : undefined;
  const bits = [
    role !== "system" ? roleLabel(role) : undefined,
    iteration ? `iteration ${iteration}${maxIterations ? `/${maxIterations}` : ""}` : undefined,
    agent,
    model,
    latest.type === "tool_call" ? tool : undefined,
    phase,
    phase ? compactToolSummary(humanizeAgentText(readString(payload, "summary") || readString(payload, "text"))).slice(0, 80) || undefined : undefined,
  ].filter(Boolean);
  return {
    stage,
    ...(iteration ? { iteration } : {}),
    ...(maxIterations ? { maxIterations } : {}),
    ...(role !== "system" ? { role } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(tool ? { tool } : {}),
    label: bits.join(" · ") || latest.type.replaceAll("_", " "),
  };
}

export function buildProcessFlow(events: HarnessEvent[], result?: DevelopmentRunResult): ProcessFlowModel {
  const view = buildRunView(events, result);
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const maxIterations = Math.max(view.live.maxIterations ?? 0, ...sorted.map((event) => readNumber(event.payload, "maxIterations")), view.metrics.iterations, 1);
  const currentIteration = Math.max(view.live.iteration ?? 0, view.metrics.iterations, 0);
  const terminal = view.stages.result !== "waiting";
  const liveStage = terminal ? "result" : view.currentStage;
  const planner = findLast(sorted, (event) => event.actor === "planner" && ["agent_started", "agent_completed", "handoff"].includes(event.type));
  const generator = findLast(sorted, (event) => event.actor === "generator" && ["agent_started", "agent_completed", "handoff", "tool_call"].includes(event.type));
  const evaluator = findLast(sorted, (event) => event.actor === "evaluator" && ["agent_started", "agent_completed", "verdict"].includes(event.type));
  const toolCount = sorted.filter((event) => event.type === "tool_call" && !isAcceptanceTool(event)).length;
  const node = (stage: WorkflowStage, detail = ""): ProcessFlowNode => ({
    id: stage,
    kind: stage,
    state: view.stages[stage],
    active: !terminal && liveStage === stage && view.stages[stage] === "active",
    ...(detail ? { detail } : {}),
  });
  const nodes = [
    node("goal"),
    node("planner", planner ? agentIdentity(planner.payload) : ""),
    node("generator", [generator ? agentIdentity(generator.payload) : "", toolCount ? `${toolCount} tools` : ""].filter(Boolean).join(" · ")),
    node("evidence", view.evidence.length ? `${view.evidence.filter((item) => item.status === "passed").length}/${view.evidence.length}` : ""),
    node("evaluator", evaluator ? readString(evaluator.payload, "reviewer") || agentIdentity(evaluator.payload) : ""),
    node("result"),
  ];
  const inboundAnimated = (target: WorkflowStage) => !terminal && liveStage === target;
  const loopActive = !terminal && currentIteration > 1 && ["generator", "evidence", "evaluator"].includes(liveStage);
  const edges: ProcessFlowEdge[] = [
    { id: "goal->planner", source: "goal", target: "planner", kind: "forward", animated: inboundAnimated("planner") },
    { id: "planner->generator", source: "planner", target: "generator", kind: "forward", animated: inboundAnimated("generator") && !loopActive },
    { id: "generator->evidence", source: "generator", target: "evidence", kind: "forward", animated: inboundAnimated("evidence") },
    { id: "evidence->evaluator", source: "evidence", target: "evaluator", kind: "forward", animated: inboundAnimated("evaluator") },
    { id: "evaluator->generator", source: "evaluator", target: "generator", kind: "loop", animated: loopActive || (inboundAnimated("generator") && currentIteration > 1), iteration: currentIteration, maxIterations },
    { id: "evaluator->result", source: "evaluator", target: "result", kind: "to-result" },
  ];
  return { nodes, edges, liveNodeId: liveStage, loop: { current: currentIteration, max: maxIterations } };
}


function currentIterationAcceptance(events: HarnessEvent[]): EvidenceRecord[] {
  const acceptanceEvents = events.filter((event) => event.type === "tool_result" && isAcceptanceTool(event));
  const currentIteration = Math.max(...acceptanceEvents.map((event) => readNumber(event.payload, "iteration")), 0);
  return acceptanceEvents
    .filter((event) => currentIteration === 0 || readNumber(event.payload, "iteration") === currentIteration)
    .flatMap(readEvidence);
}

export function readEvidence(event: HarnessEvent): EvidenceRecord[] {
  if (event.type !== "tool_result" || !isRecord(event.payload)) return [];
  const value = event.payload.evidence;
  if (!isRecord(value) || value.source !== "configured_acceptance" || typeof value.id !== "string" || typeof value.status !== "string") return [];
  return [value as unknown as EvidenceRecord];
}

export function readReview(event: HarnessEvent): RunReview[] {
  if (event.type !== "verdict" || !isRecord(event.payload)) return [];
  const { reviewer, decision, text, iteration, status } = event.payload;
  if (typeof reviewer !== "string" || !["accept", "request_changes", "unavailable"].includes(String(decision)) || typeof text !== "string") return [];
  return [{
    sourceEventId: event.id,
    reviewer,
    decision: decision as DevelopmentReview["decision"],
    text,
    ...(status === "completed" || status === "control_missing" ? { status } : {}),
    ...(typeof iteration === "number" ? { iteration } : {}),
  }];
}

export function eventLabel(event: HarnessEvent): string {
  const payload = isRecord(event.payload) ? event.payload : {};
  const identity = agentIdentity(payload);
  const iteration = readNumber(payload, "iteration");
  const iter = iteration ? `iteration ${iteration}` : undefined;
  if (event.type === "handoff" && event.actor === "planner") return ["Planner handoff", identity].filter(Boolean).join(" · ");
  if (event.type === "handoff" && event.actor === "generator") return ["Generator handoff", iter, identity].filter(Boolean).join(" · ");
  if (event.type === "agent_started") return [roleLabel(event.actor), "started", iter, identity].filter(Boolean).join(" · ");
  if (event.type === "agent_completed") return [roleLabel(event.actor), "finished", iter, identity, formatDurationLabel(readNumber(payload, "durationMs"))].filter(Boolean).join(" · ");
  if (event.type === "agent_failed") return [roleLabel(event.actor), "failed", iter, identity].filter(Boolean).join(" · ");
  if (event.type === "tool_call") {
    if (isAcceptanceTool(event)) return `acceptance started · ${acceptanceEventName(payload)}`;
    return ["tool", readString(payload, "tool") || readString(payload, "name") || "tool", iter, identity].filter(Boolean).join(" · ");
  }
  if (event.type === "tool_result") {
    if (isRecord(payload.evidence) && payload.evidence.source === "configured_acceptance") {
      return `acceptance ${String(payload.evidence.status)} · ${acceptanceEvidenceName(payload.evidence)}`;
    }
    return ["tool finished", readString(payload, "tool") || "tool", iter].filter(Boolean).join(" · ");
  }
  if (event.type === "message" && readString(payload, "action") !== "stop_requested") {
    const phase = readString(payload, "phase") || "draft";
    return [roleLabel(event.actor), phase, iter, identity].filter(Boolean).join(" · ");
  }
  if (event.type === "verdict") return ["Review", readString(payload, "reviewer") || identity, readString(payload, "decision").replaceAll("_", " ")].filter(Boolean).join(" · ");
  if (event.type === "iteration_started") return `Iteration ${readNumber(payload, "iteration")}${readNumber(payload, "maxIterations") ? ` of ${readNumber(payload, "maxIterations")}` : ""} started`;
  if (event.type === "iteration_completed") return `Iteration ${readNumber(payload, "iteration")} completed`;
  return event.type.replaceAll("_", " ");
}

export function eventDetail(event: HarnessEvent): string {
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type === "handoff") return humanizeAgentText(readString(payload, "summary") || readString(payload, "plan"));
  if (event.type === "message" && readString(payload, "action") !== "stop_requested") {
    return humanizeAgentText(readString(payload, "summary") || readString(payload, "text") || readString(payload, "message"));
  }
  if (event.type === "tool_call") return [executionLabel(payload), compactToolSummary(readString(payload, "summary") || readString(payload, "command") || readString(payload, "name"))].filter(Boolean).join(" · ");
  if (event.type === "tool_result" && isRecord(payload.evidence)) {
    const evidence = payload.evidence;
    return [String(evidence.runtimeId ?? evidence.placement ?? ""), String(evidence.failureCategory ?? ""), String(evidence.summary ?? ""), formatDurationLabel(Number(evidence.durationMs ?? 0))].filter(Boolean).join(" · ");
  }
  if (event.type === "tool_result") return [executionLabel(payload), compactToolSummary(readString(payload, "summary"))].filter(Boolean).join(" · ");
  if (event.type === "verdict") return humanizeAgentText(readString(payload, "summary"));
  if (event.type === "agent_failed") return readString(payload, "summary") || readString(payload, "message");
  if (event.type === "run_failed") return humanizeAgentText(readString(payload, "summary") || readString(payload, "message"));
  if (event.type === "agent_started" || event.type === "agent_completed") return agentIdentity(payload);
  return "";
}

export function humanizeAgentText(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!looksLikeStreamDump(raw)) return raw;
  const parts: string[] = [];
  let stopReason = "";
  let claudeResult = "";
  let codexMessage = "";
  for (const line of raw.split("\n")) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if ((record.type === "text" || record.type === "thought") && typeof record.data === "string") parts.push(record.data);
      if (record.type === "end" && typeof record.stopReason === "string") stopReason = record.stopReason;
      if (record.type === "result" && typeof record.result === "string") claudeResult = record.result;
      if (record.type === "assistant" && isRecord(record.message) && Array.isArray(record.message.content)) {
        for (const block of record.message.content) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
        }
      }
      if ((record.type === "item.completed" || record.type === "item.updated") && isRecord(record.item) && record.item.type === "agent_message" && typeof record.item.text === "string") {
        codexMessage = record.item.text;
      }
    } catch { /* 当前记录不可解析时继续查找更早的有效状态。 */ }
  }
  if (parts.join("").trim()) return parts.join("").replace(/\s+/g, " ").trim();
  if (claudeResult.trim()) return claudeResult.trim();
  if (codexMessage.trim()) return codexMessage.replace(/\s+/g, " ").trim();
  if (stopReason) return stopReason === "Cancelled" ? "Agent run was cancelled before a final answer." : `Agent stopped (${stopReason}).`;
  return "Agent produced no readable final text.";
}

function looksLikeStreamDump(value: string): boolean {
  const sample = value.slice(0, 320).trim();
  if (!sample.startsWith("{") && !sample.startsWith("[")) return false;
  return (
    sample.includes('"type":"thought"')
    || sample.includes('"type":"text"')
    || sample.includes('"type":"end"')
    || sample.includes('"type":"assistant"')
    || sample.includes('"type":"result"')
    || sample.includes('"type":"item.started"')
    || sample.includes('"type":"item.completed"')
  );
}

function agentIdentity(payload: unknown): string {
  if (!isRecord(payload)) return "";
  return [readString(payload, "agentId") || readString(payload, "backend"), readString(payload, "model")].filter(Boolean).join(" · ");
}

function roleLabel(actor: string): string {
  return actor === "planner" || actor === "generator" || actor === "evaluator" ? "Agent" : actor === "safety" ? "Safety" : actor;
}

function latestIterationFrom(events: HarnessEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = readNumber(events[index]?.payload, "iteration");
    if (value > 0) return value;
  }
  return 0;
}

function latestMaxIterationsFrom(events: HarnessEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = readNumber(events[index]?.payload, "maxIterations");
    if (value > 0) return value;
  }
  return 0;
}

function compactToolSummary(value: string): string {
  const raw = value.replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const unwrapped = raw.replace(/^\/bin\/(?:ba)?zsh\s+-lc\s+["']?/, "").replace(/["']$/, "");
  return unwrapped.length > 120 ? `${unwrapped.slice(0, 119)}…` : unwrapped;
}

function isAcceptanceTool(event: HarnessEvent): boolean {
  if (!isRecord(event.payload)) return false;
  if (isRecord(event.payload.evidence) && event.payload.evidence.source === "configured_acceptance") return true;
  return event.payload.tool === "acceptance";
}

function acceptanceEventName(payload: Record<string, unknown>): string {
  return isRecord(payload.acceptance) && typeof payload.acceptance.name === "string" ? payload.acceptance.name : "acceptance";
}

function acceptanceEvidenceName(evidence: Record<string, unknown>): string {
  const native = isRecord(evidence.native) ? evidence.native : {};
  const acceptance = isRecord(native.acceptance) ? native.acceptance : {};
  return typeof acceptance.name === "string" ? acceptance.name : String(evidence.capability ?? "acceptance");
}

function executionLabel(payload: Record<string, unknown>): string {
  if (!isRecord(payload.execution)) return "";
  return [String(payload.execution.owner ?? ""), String(payload.execution.placement ?? "")].filter(Boolean).join("/");
}

function formatDurationLabel(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function readIteration(event: HarnessEvent): number {
  return readNumber(event.payload, "iteration");
}

function readString(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function readNumber(value: unknown, key: string): number {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
}
