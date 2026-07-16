import { createId, defaultExecutionPolicy, type ApprovalDecision, type ApprovalRequest, type CapabilitySnapshot, type DevelopmentConfig, type DevelopmentPlan, type DevelopmentReview, type DevelopmentRunResult, type EvidenceRecord, type ExecutionPolicy, type PermissionAction, type PermissionDecision, type SafetyClassifierConfig, type WorkspacePlacement } from "@runharness/shared";
import { SessionMemoryStore, type JsonlSessionStore, type PromptRegistry } from "@runharness/core";
import type { AgentPool } from "@runharness/providers";
import { controlMcpServer, permissionAllowRule, reviewDecisionFromTool, safetyDecisionFromTool, PermissionRequiredError } from "@runharness/providers";
import type { AgentActivity, AgentCall } from "@runharness/providers";
import type { AgentImage } from "@runharness/providers";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { collectChangeSet, inspectAuxiliaryWorktrees, prepareDevelopmentWorkspace, reuseDevelopmentWorkspace, updateWorkspaceRecord, type GitBaseline } from "../workspace/manager.js";
import { requiredAcceptancePassed, runAcceptance } from "../verification/acceptance.js";
import { createExecutionRuntimes, ExecutionRuntimeRegistry, type ExecutionRuntimeFactory } from "../runtime/execution-runtime.js";
import { priorRunEvidence } from "./run-context.js";
import { classifyFailure } from "../runtime/failure.js";

/** 启动或恢复一次开发 Run 所需的完整边界输入。 */
export interface DevelopmentRequest {
  goal: string;
  source: string;
  workspaceRoot: string;
  runtimeRoot?: string;
  contextRoot?: string;
  placement?: WorkspacePlacement;
  maxIterations?: number;
  sessionId?: string;
  previousSessionId?: string;
  images?: AgentImage[];
  signal?: AbortSignal;
  resumeWorkspace?: string;
  originalGoal?: string;
  baselineCommit?: string;
  baselineRepository?: string;
  sourceRoot?: string;
  allowNetwork?: boolean;
  planReview?: "auto" | "require_approval";
  approvedPlan?: DevelopmentPlan;
  executionPolicy?: ExecutionPolicy;
  safetyClassifier?: SafetyClassifierConfig;
  requestApproval?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
}

/** 串联规划、实现、证据、评审、迭代和终态清理，是开发自循环的主流程。 */
export class DevelopmentHarness {
  constructor(
    private readonly pool: AgentPool,
    private readonly sessions: JsonlSessionStore,
    private readonly prompts: PromptRegistry,
    private readonly config: DevelopmentConfig = { acceptance: [], maxIterations: 3, maxDiffChars: 120_000 },
    private readonly runtimeFactory: ExecutionRuntimeFactory = createExecutionRuntimes,
  ) {}

  async run(request: DevelopmentRequest): Promise<DevelopmentRunResult> {
    const configuredPolicy = request.executionPolicy ?? defaultExecutionPolicy;
    const placement = request.placement ?? configuredPolicy.workspace.placement;
    const resumingApprovedPlan = Boolean(request.approvedPlan);
    const session = request.sessionId ? await this.sessions.getSession(request.sessionId) : await this.sessions.create(request.goal);
    await this.sessions.setWorkspaceState(session.id, { workspacePlacement: placement, workspaceAccess: configuredPolicy.workspace.access, deliveryStatus: placement === "isolated" ? "pending" : "live" });
    await this.sessions.setStatus(session.id, "running");
    const run = await this.sessions.getRun(session.id);
    let workspace = "";
    let baseline: GitBaseline | undefined;
    let iterations = 0;
    let activeIteration = 0;
    let runtimeRegistry: ExecutionRuntimeRegistry | undefined;
    const originalGoal = request.originalGoal ?? request.goal;
    const runtimeRoot = path.resolve(request.runtimeRoot ?? path.dirname(request.workspaceRoot));
    const scratch = path.join(runtimeRoot, "scratch", session.id, run.id);
    const max = Math.max(1, request.maxIterations ?? this.config.maxIterations);
    const activity = async (actor: "planner" | "generator" | "evaluator" | "safety", item: AgentActivity) => {
      const execution = item.execution ?? { owner: "provider" as const, placement: "unknown" as const, controlled: false };
      const evidence = ["tool_call", "tool_result"].includes(item.kind) ? {
        id: item.callId ?? createId("evidence"),
        source: actor === "evaluator" ? "evaluator" as const : "agent" as const,
        owner: execution.owner,
        ...(execution.runtimeId ? { runtimeId: execution.runtimeId } : {}),
        placement: execution.placement,
        capability: item.tool ?? "provider-tool",
        requirement: "exploratory" as const,
        status: item.kind === "tool_call" ? "started" as const : item.success === false ? "failed" as const : "passed" as const,
        blocksCompletion: false,
        summary: item.summary ?? item.tool ?? "Provider tool activity",
        startedAt: new Date().toISOString(),
        ...(item.kind === "tool_result" ? { completedAt: new Date().toISOString(), durationMs: item.durationMs } : {}),
        artifacts: [],
        native: item,
      } satisfies EvidenceRecord : undefined;
      await this.sessions.emit(session.id, actor, item.kind, { ...item, execution, ...(evidence ? { evidence } : {}), stage: actor, ...(activeIteration ? { iteration: activeIteration } : {}) });
    };
    const memory = new SessionMemoryStore(path.resolve(request.runtimeRoot ?? path.dirname(request.contextRoot ?? request.workspaceRoot)));
    if (!resumingApprovedPlan && session.runCount === 1 && session.eventCount === 0) await this.sessions.emit(session.id, "system", "session_started", { kind: "development", goal: originalGoal });
    if (!resumingApprovedPlan) await this.sessions.emit(session.id, "system", "run_started", { kind: "development", runId: run.id, placement, source: request.source, goal: originalGoal, userInput: request.goal, maxIterations: max, attachments: (request.images ?? []).map(({ id, name, mediaType, size }) => ({ id, name, mediaType, size })) });
    try {
      request.signal?.throwIfAborted();
      const prepared = request.resumeWorkspace && request.baselineCommit && request.sourceRoot
        ? placement === "isolated"
          ? await reuseDevelopmentWorkspace({ workspace: request.resumeWorkspace, workspaceRoot: request.workspaceRoot, baselineCommit: request.baselineCommit, sourceRoot: request.sourceRoot })
          : { workspace: request.sourceRoot, baseline: { repository: request.baselineRepository ?? path.join(runtimeRoot, "git", "object-cache.git"), commit: request.baselineCommit, sourceRoot: request.sourceRoot, placement: "in_place" as const } }
        : await prepareDevelopmentWorkspace({ source: request.source, placement, sessionId: session.id, workspaceRoot: request.workspaceRoot, runtimeRoot, access: configuredPolicy.workspace.access, materializeIgnored: configuredPolicy.workspace.materializeIgnored });
      workspace = prepared.workspace;
      baseline = prepared.baseline;
      await mkdir(scratch, { recursive: true });
      const auxiliaryRoot = placement === "isolated" ? path.join(path.dirname(workspace), "worktrees") : undefined;
      const providerEnvironment = { TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CACHE_HOME: path.join(scratch, "cache"), ...(auxiliaryRoot ? { RUNHARNESS_WORKTREE_ROOT: auxiliaryRoot } : {}) };
      const writableRoots = [scratch, ...(auxiliaryRoot ? [path.dirname(workspace)] : [])];
      await memory.initialize(session.id, originalGoal);
      await this.sessions.emit(session.id, "system", "context", { strategy: "workspace-ready", workspace, baselineCommit: baseline.commit, baselineRepository: baseline.repository, sourceRoot: baseline.sourceRoot });
      const executionPolicy: ExecutionPolicy = {
        ...configuredPolicy,
        workspace: { ...configuredPolicy.workspace, placement },
        network: request.allowNetwork === true ? "allow_all" : request.executionPolicy?.network ?? defaultExecutionPolicy.network,
        customRules: request.executionPolicy?.customRules ?? [],
      };
      const permission: NonNullable<AgentCall["permission"]> = {
        policy: executionPolicy,
        decide: async (action: PermissionAction, baseDecision: PermissionDecision) => {
          const classified = await this.authorizePermission(session.id, run.id, originalGoal, workspace, action, baseDecision, request.safetyClassifier, (item) => activity("safety", item));
          if (classified.decision !== "ask" || !request.requestApproval || !baseline) return classified;
          const human = await this.waitForPermissionDecision({
            sessionId: session.id,
            runId: run.id,
            workspace,
            placement,
            baseline,
            ...(request.approvedPlan ? { plan: request.approvedPlan } : {}),
            action,
            baseDecision: classified,
            requestApproval: request.requestApproval,
            ...(request.signal ? { signal: request.signal } : {}),
          });
          if (human.decision === "approve") {
            if (human.scope !== "once") {
              const rule = permissionAllowRule(action);
              executionPolicy.customRules = [rule, ...executionPolicy.customRules.filter((item) => item.id !== rule.id)];
            }
            return { decision: "allow", source: "human", reason: human.reason ?? `Approved for ${human.scope}` };
          }
          return { decision: "deny", source: "human", reason: human.reason ?? "Rejected by user" };
        },
      };
      runtimeRegistry = new ExecutionRuntimeRegistry(this.runtimeFactory(this.config.mcpServers));
      const capabilities: CapabilitySnapshot = { agents: this.pool.capabilityAgents(), runtimes: runtimeRegistry.descriptors(), acceptance: this.config.acceptance };
      await this.sessions.emit(session.id, "system", "context", { strategy: "capability-snapshot", capabilities });
      const plannerPrompt = await this.prompts.compose("planner", run.id);
      const generatorPrompt = await this.prompts.compose("generator", run.id);
      const evaluatorPrompt = await this.prompts.compose("evaluator", run.id);
      for (const snapshot of resumingApprovedPlan ? [generatorPrompt, evaluatorPrompt] : [plannerPrompt, generatorPrompt, evaluatorPrompt])
        await this.sessions.emit(session.id, "system", "prompt_snapshot", snapshot);
      const priorEvidence = request.previousSessionId
        ? await this.priorRunEvidence(request.previousSessionId, "")
        : session.runCount > 1 ? await this.priorRunEvidence(session.id, run.id) : undefined;
      let packet;
      let context;
      let plan: DevelopmentPlan;
      if (request.approvedPlan) {
        plan = { ...request.approvedPlan, status: "approved", updatedAt: new Date().toISOString() };
      } else {
        request.signal?.throwIfAborted();
        const budget = typeof this.pool.contextBudgetChars === "function" ? await this.pool.contextBudgetChars("planner") : 6_000;
        packet = await memory.assemble({ sessionId: session.id, runId: run.id, stage: "planner", goal: originalGoal, userRequest: request.goal, workspace, budgetChars: budget, currentEvidence: JSON.stringify({ capabilities, priorEvidence }, null, 2), nextAction: "Plan the smallest verifiable change. Do not edit files." });
        context = { filePath: packet.filePath, summary: packet.content };
        await this.sessions.emit(session.id, "system", "context", { path: packet.filePath, strategy: "indexed-memory-and-references", bounded: true, selected: packet.selected.map((item) => item.id) });
        const plannerCall = { cwd: workspace, systemPrompt: plannerPrompt.systemPrompt, context, permission, environment: providerEnvironment, writableRoots, conversation: { runHarnessSessionId: session.id, persist: true }, ...(request.images?.length ? { images: request.images } : {}), ...(request.signal ? { signal: request.signal } : {}), onActivity: (item: AgentActivity) => activity("planner", item), options: { workspaceMode: executionPolicy.workspace.access === "read_only" ? "read" as const : "write" as const, executionPolicy } };
        const planResponse = await this.pool.complete("planner", { ...plannerCall, prompt: `${plannerPrompt.userContext}\n\nInspect the repository and respond with the planning output you consider useful. RunHarness records your response as-is.` });
        const text = planResponse.text;
        const createdAt = new Date().toISOString();
        plan = { version: 1, text, status: request.planReview === "require_approval" ? "proposed" : "approved", createdAt, updatedAt: createdAt };
        await this.sessions.emit(session.id, "planner", "handoff", { backend: planResponse.backend, model: planResponse.model, plan: text });
        await this.sessions.emit(session.id, "planner", "plan_proposed", plan);
        if (request.planReview !== "require_approval") await this.sessions.emit(session.id, "system", "plan_approved", { version: plan.version, automatic: true });
      }
      const initial = emptyResult(session.id, run.id, workspace, placement, baseline, plan);
      await this.sessions.saveResult(session.id, initial, run.id);
      if (plan.status === "proposed") {
        await this.sessions.setStatus(session.id, "waiting_for_plan_approval");
        return initial;
      }
    let feedback = "No previous attempt."; let evidence: EvidenceRecord[] = []; let reviews: DevelopmentReview[] = []; let changes = await collectChangeSet(workspace, baseline, this.config.maxDiffChars); let completed = false;
    for (let iteration = 1; iteration <= max; iteration += 1) {
      iterations = iteration;
      activeIteration = iteration;
      request.signal?.throwIfAborted();
      await this.sessions.setIterationCount(session.id, iterations);
      await this.sessions.emit(session.id, "system", "iteration_started", { iteration: iterations, maxIterations: max });
      packet = await memory.assemble({ sessionId: session.id, runId: run.id, stage: "generator", goal: originalGoal, userRequest: request.goal, workspace, budgetChars: typeof this.pool.contextBudgetChars === "function" ? await this.pool.contextBudgetChars("generator") : 6_000, currentEvidence: JSON.stringify({ plan: plan.text, capabilities, changes: { status: changes.status, changedFiles: changes.changedFiles }, evidence, reviews, feedback }, null, 2), nextAction: "Implement the requested change and inspect repository evidence directly." });
      context = { filePath: packet.filePath, summary: packet.content };
      const generator = await this.pool.complete("generator", { cwd: workspace, systemPrompt: generatorPrompt.systemPrompt, context, permission, environment: providerEnvironment, writableRoots, conversation: { runHarnessSessionId: session.id, persist: true }, ...(request.images?.length ? { images: request.images } : {}), ...(request.signal ? { signal: request.signal } : {}), onActivity: (item) => activity("generator", item), options: { workspaceMode: executionPolicy.workspace.access === "read_only" ? "read" : "write", executionPolicy }, prompt: `${generatorPrompt.userContext}\n\nImplement the approved plan recorded in the RunHarness context.` });
      request.signal?.throwIfAborted();
      await this.sessions.emit(session.id, "generator", "handoff", { iteration: iterations, backend: generator.backend, model: generator.model, summary: generator.text });
      evidence = await runAcceptance(this.config.acceptance, runtimeRegistry, { workspace, ...(request.signal ? { signal: request.signal } : {}), permission }, async (spec) => {
        const descriptor = runtimeRegistry?.descriptors().find((item) => item.id === spec.runtime);
        await this.sessions.emit(session.id, "generator", "tool_call", { iteration: iterations, tool: "acceptance", acceptance: spec, execution: descriptor });
      });
      for (const item of evidence) await this.sessions.emit(session.id, "generator", "tool_result", { iteration: iterations, evidence: item });
      request.signal?.throwIfAborted();
      changes = await collectChangeSet(workspace, baseline, this.config.maxDiffChars);
      packet = await memory.assemble({ sessionId: session.id, runId: run.id, stage: "evaluator", goal: originalGoal, userRequest: request.goal, workspace, budgetChars: typeof this.pool.contextBudgetChars === "function" ? await this.pool.contextBudgetChars("evaluator") : 6_000, currentEvidence: JSON.stringify({ plan: plan.text, capabilities, changes: { status: changes.status, changedFiles: changes.changedFiles, deletedFiles: changes.deletedFiles }, evidence }, null, 2), nextAction: "Independently review the current repository state and available evidence. Gather more evidence when it materially tests acceptance." });
      context = { filePath: packet.filePath, summary: packet.content };
      reviews = await this.review(context, session.id, workspace, evaluatorPrompt, permission, providerEnvironment, writableRoots, request.images, request.signal, (item) => activity("evaluator", item));
      request.signal?.throwIfAborted();
      for (const review of reviews) await this.sessions.emit(session.id, "evaluator", "verdict", { iteration: iterations, ...review });
      const acceptancePass = requiredAcceptancePassed(evidence); const reviewServiceFailed = reviews.some((review) => review.status === "control_missing" || review.decision === "unavailable"); const reviewsPass = reviews.length > 0 && reviews.every((review) => review.status !== "control_missing" && review.decision === "accept");
      if (acceptancePass && reviewsPass) { completed = true; break; }
      if (reviewServiceFailed) {
        await this.sessions.emit(session.id, "system", "iteration_completed", { iteration: iterations, completed: false, acceptancePass, reviewsPass, reviewServiceFailed });
        break;
      }
      feedback = JSON.stringify({ blockingEvidence: evidence.filter((item) => item.blocksCompletion), reviewFeedback: reviews.filter((item) => item.decision === "request_changes").map((item) => item.text), changedFiles: changes.changedFiles }, null, 2);
      await this.sessions.emit(session.id, "system", "iteration_completed", { iteration: iterations, completed: false, acceptancePass, reviewsPass, reviewServiceFailed });
    }
      const reviewStatus = reviews.some((review) => review.status === "control_missing" || review.decision === "unavailable") ? "pending" as const : "completed" as const;
      const result: DevelopmentRunResult = { sessionId: session.id, runId: run.id, workspace, placement, iterations, completed, changes, evidence, reviews, plan, reviewStatus, baselineCommit: baseline.commit, baselineRepository: baseline.repository, sourceRoot: baseline.sourceRoot, delivery: { status: placement === "isolated" ? "pending" : "applied" } };
      if (placement === "isolated") await updateWorkspaceRecord(runtimeRoot, session.id, { state: "retained", auxiliaryWorktrees: await inspectAuxiliaryWorktrees(workspace) });
      await this.sessions.saveResult(session.id, result, run.id);
      const reviewServiceFailed = reviews.some((review) => review.status === "control_missing" || review.decision === "unavailable");
      const failure = !completed ? !requiredAcceptancePassed(evidence)
        ? { category: "acceptance", recoverable: true, nextAction: "Resolve the blocking acceptance evidence recorded for the next Run." }
        : reviewServiceFailed
          ? { category: "review", recoverable: true, nextAction: "Retry the unavailable Evaluator or explicitly override it after inspecting the recorded evidence." }
          : { category: "review", recoverable: true, nextAction: "Address or dispute the blocking review evidence in the next Run." } : undefined;
      await this.sessions.emit(session.id, "system", completed ? "run_completed" : "run_failed", { kind: "development", completed, reviewStatus, iterations, workspace, changes: { status: changes.status, changedFiles: changes.changedFiles }, evidence, reviews, ...(failure ? { failure } : {}) });
      await this.sessions.setStatus(session.id, completed ? "completed" : "failed");
      await memory.recordRun(session.id, originalGoal, await this.sessions.getRun(session.id, run.id), result);
      return result;
    } catch (error) {
      if (error instanceof PermissionRequiredError && workspace && baseline) {
        const approval = {
          id: createId("approval"),
          sessionId: session.id,
          runId: run.id,
          action: error.action,
          baseDecision: error.decision,
          status: "pending" as const,
          createdAt: new Date().toISOString(),
        };
        const current = await this.sessions.getResult<DevelopmentRunResult>(session.id, run.id) ?? emptyResult(session.id, run.id, workspace, placement, baseline, request.approvedPlan);
        const waiting = { ...current, pendingApproval: approval };
        await this.sessions.saveResult(session.id, waiting, run.id);
        await this.sessions.emit(session.id, "system", "approval_requested", approval);
        await this.sessions.setStatus(session.id, "waiting_for_permission");
        return waiting;
      }
      if ((error instanceof Error && error.name === "AbortError") || request.signal?.aborted) {
        if (workspace && baseline) {
          const changes = await collectChangeSet(workspace, baseline, this.config.maxDiffChars).catch(() => emptyChanges(workspace));
          const stopped = { ...emptyResult(session.id, run.id, workspace, placement, baseline, request.approvedPlan), iterations, changes };
          await this.sessions.saveResult(session.id, stopped, run.id);
          await this.sessions.emit(session.id, "system", "workspace_checkpoint", { workspace, baselineCommit: baseline.commit, iterations, changes: { status: changes.status, changedFiles: changes.changedFiles, deletedFiles: changes.deletedFiles } });
          if (placement === "isolated") await updateWorkspaceRecord(runtimeRoot, session.id, { state: "retained", auxiliaryWorktrees: await inspectAuxiliaryWorktrees(workspace).catch(() => []) });
          await memory.recordRun(session.id, originalGoal, await this.sessions.getRun(session.id, run.id), stopped, "Stopped by user");
        }
        await this.sessions.emit(session.id, "system", "run_stopped", { kind: "development", message: "Stopped by user", workspace: workspace || undefined });
        await this.sessions.setStatus(session.id, "stopped");
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyFailure(message);
      let failedResult: DevelopmentRunResult | undefined;
      if (workspace && baseline) {
        const changes = await collectChangeSet(workspace, baseline, this.config.maxDiffChars).catch(() => emptyChanges(workspace));
        failedResult = { ...emptyResult(session.id, run.id, workspace, placement, baseline), iterations, changes };
        await this.sessions.saveResult(session.id, failedResult, run.id);
        if (placement === "isolated") await updateWorkspaceRecord(runtimeRoot, session.id, { state: "retained", auxiliaryWorktrees: await inspectAuxiliaryWorktrees(workspace).catch(() => []) });
      }
      await this.sessions.emit(session.id, "system", "run_failed", { kind: "development", message, failure, workspace: workspace || undefined });
      await this.sessions.setStatus(session.id, "failed");
      if (failedResult) await memory.recordRun(session.id, request.originalGoal ?? request.goal, await this.sessions.getRun(session.id, run.id), failedResult, message);
      throw error;
    } finally {
      await runtimeRegistry?.stop();
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async authorizePermission(
    sessionId: string,
    runId: string,
    goal: string,
    workspace: string,
    action: PermissionAction,
    baseDecision: PermissionDecision,
    classifier: SafetyClassifierConfig | undefined,
    onActivity: (item: AgentActivity) => void | Promise<void>,
  ): Promise<PermissionDecision> {
    if (baseDecision.decision !== "allow" || !classifier?.enabled) return baseDecision;
    if (!classifier.agentId) return classifier.fallback === "ask"
      ? { decision: "ask", source: "builtin", reason: "Safety classifier is enabled but no Agent is configured", category: "unknown" }
      : baseDecision;
    try {
      const prompt = await this.prompts.compose("safety_classifier", runId);
      await this.sessions.emit(sessionId, "system", "prompt_snapshot", prompt);
      let signal: ReturnType<typeof safetyDecisionFromTool>;
      let multipleSignals = false;
      const pendingSignals = new Map<string, NonNullable<ReturnType<typeof safetyDecisionFromTool>>>();
      const response = await this.pool.completeAgent(classifier.agentId, "safety_classifier", {
        cwd: workspace,
        systemPrompt: prompt.systemPrompt,
        prompt: `${prompt.userContext}\n\n${JSON.stringify({ goal, action, baseDecision })}`,
        mcpServers: { runharness_control: controlMcpServer("safety") },
        onActivity: async (item) => {
          const candidate = safetyDecisionFromTool(item.tool);
          if (item.kind === "tool_call" && candidate && item.callId) pendingSignals.set(item.callId, candidate);
          if (item.kind === "tool_result" && item.success === true) {
            const completed = candidate ?? (item.callId ? pendingSignals.get(item.callId) : undefined);
            if (completed && signal) multipleSignals = true;
            else if (completed) signal = completed;
          }
          if (item.kind === "tool_result" && item.callId) pendingSignals.delete(item.callId);
          await onActivity(item);
        },
      });
      if (multipleSignals) throw new Error("Safety Agent completed more than one RunHarness decision tool");
      if (!signal) throw new Error("Safety Agent returned without calling a RunHarness decision tool");
      const decision: PermissionDecision = { decision: signal, source: "safety_classifier", reason: response.text.trim() || `Safety Agent selected ${signal}` };
      await this.sessions.emit(sessionId, "safety", "message", { phase: "status", summary: `${decision.decision}: ${decision.reason}`, action });
      return decision;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.sessions.emit(sessionId, "safety", "message", { phase: "status", summary: `classifier_unavailable: ${reason}`, action });
      return classifier.fallback === "ask"
        ? { decision: "ask", source: "builtin", reason: `Safety classifier unavailable: ${reason}`, category: "unknown" }
        : baseDecision;
    }
  }

  private async waitForPermissionDecision(input: {
    sessionId: string;
    runId: string;
    workspace: string;
    placement: WorkspacePlacement;
    baseline: GitBaseline;
    plan?: DevelopmentPlan;
    action: PermissionAction;
    baseDecision: PermissionDecision;
    requestApproval: NonNullable<DevelopmentRequest["requestApproval"]>;
    signal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    const approval: ApprovalRequest = {
      id: createId("approval"),
      sessionId: input.sessionId,
      runId: input.runId,
      action: input.action,
      baseDecision: input.baseDecision,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const current = await this.sessions.getResult<DevelopmentRunResult>(input.sessionId, input.runId)
      ?? emptyResult(input.sessionId, input.runId, input.workspace, input.placement, input.baseline, input.plan);
    await this.sessions.saveResult(input.sessionId, { ...current, pendingApproval: approval }, input.runId);
    await this.sessions.emit(input.sessionId, "system", "approval_requested", approval);
    await this.sessions.setStatus(input.sessionId, "waiting_for_permission");
    try {
      const decision = await input.requestApproval(approval, input.signal);
      const latest = await this.sessions.getResult<DevelopmentRunResult>(input.sessionId, input.runId) ?? current;
      const resumed = { ...latest };
      delete resumed.pendingApproval;
      await this.sessions.saveResult(input.sessionId, resumed, input.runId);
      await this.sessions.emit(input.sessionId, "human", "approval_decided", decision);
      await this.sessions.setStatus(input.sessionId, "running");
      return decision;
    } catch (error) {
      const latest = await this.sessions.getResult<DevelopmentRunResult>(input.sessionId, input.runId);
      if (latest?.pendingApproval?.id === approval.id) {
        const cleared = { ...latest };
        delete cleared.pendingApproval;
        await this.sessions.saveResult(input.sessionId, cleared, input.runId);
      }
      throw error;
    }
  }

  private async priorRunEvidence(sessionId: string, currentRunId: string): Promise<string> {
    const events = (await this.sessions.getEvents(sessionId)).filter((event) => event.runId !== currentRunId);
    const runs = (await this.sessions.listRuns(sessionId)).filter((item) => item.id !== currentRunId);
    const evidence = await Promise.all(runs.map(async (item) => ({ runId: item.id, message: item.message, evidence: priorRunEvidence(events.filter((event) => event.runId === item.id), await this.sessions.getResult<DevelopmentRunResult>(sessionId, item.id)) })));
    return JSON.stringify(evidence.reverse(), null, 2);
  }

  private async review(context: { filePath: string; summary: string }, sessionId: string, workspace: string, promptSnapshot: Awaited<ReturnType<PromptRegistry["compose"]>>, permission: NonNullable<AgentCall["permission"]>, environment: NodeJS.ProcessEnv, writableRoots: string[], images?: AgentImage[], signal?: AbortSignal, onActivity?: (item: AgentActivity) => void | Promise<void>): Promise<DevelopmentReview[]> {
    const systemPrompt = promptSnapshot.systemPrompt;
    const decisions = new Map<string, NonNullable<ReturnType<typeof reviewDecisionFromTool>>>();
    const conflictingDecisions = new Set<string>();
    const pendingDecisions = new Map<string, Map<string, NonNullable<ReturnType<typeof reviewDecisionFromTool>>>>();
    const observe = async (item: AgentActivity) => {
      const decision = reviewDecisionFromTool(item.tool);
      if (item.kind === "tool_call" && decision && item.callId) {
        const pending = pendingDecisions.get(item.backend) ?? new Map();
        pending.set(item.callId, decision);
        pendingDecisions.set(item.backend, pending);
      }
      if (item.kind === "tool_result" && item.success === true) {
        const completed = decision ?? (item.callId ? pendingDecisions.get(item.backend)?.get(item.callId) : undefined);
        if (completed && decisions.has(item.backend)) {
          decisions.delete(item.backend);
          conflictingDecisions.add(item.backend);
        } else if (completed && !conflictingDecisions.has(item.backend)) decisions.set(item.backend, completed);
      }
      if (item.kind === "tool_result" && item.callId) pendingDecisions.get(item.backend)?.delete(item.callId);
      await onActivity?.(item);
    };
    const responses = await this.pool.completeMany("evaluator", {
      cwd: workspace,
      systemPrompt,
      context,
      permission,
      environment,
      writableRoots,
      options: { workspaceMode: permission.policy.workspace.access === "read_only" ? "read" : "write", executionPolicy: permission.policy },
      conversation: { runHarnessSessionId: sessionId, persist: false },
      mcpServers: { runharness_control: controlMcpServer("review") },
      ...(images?.length ? { images } : {}),
      ...(signal ? { signal } : {}),
      onActivity: observe,
      prompt: `${promptSnapshot.userContext}\n\nReview the current repository change against the approved plan, repository instructions, configured acceptance, and available evidence. Use any available capability when more evidence is material. Write your review naturally, then call exactly one RunHarness review control tool.`,
    });
    return Promise.all(responses.map(async (response) => {
      const reviewer = `${response.backend}${response.model ? `:${response.model}` : ""}`;
      let decision = decisions.get(response.backend);
      let recoveryText = "";
      if (!decision) {
        conflictingDecisions.delete(response.backend);
        pendingDecisions.delete(response.backend);
        try {
          const recovered = await this.pool.complete("evaluator", {
            cwd: workspace,
            systemPrompt,
            permission,
            environment,
            writableRoots,
            options: { workspaceMode: permission.policy.workspace.access === "read_only" ? "read" : "write", executionPolicy: permission.policy },
            conversation: { runHarnessSessionId: sessionId, persist: false },
            mcpServers: { runharness_control: controlMcpServer("review") },
            ...(signal ? { signal } : {}),
            onActivity: observe,
            prompt: `${promptSnapshot.userContext}\n\nThe review below ended without a completed RunHarness lifecycle decision. Do not repeat repository inspection. Use the existing evidence, briefly state the conclusion if needed, and call exactly one of review_accept, review_request_changes, or review_unavailable now.\n\nExisting review:\n${response.text || "No final review text was produced."}`,
          }, { preferred: response.backend });
          recoveryText = recovered.text;
          decision = decisions.get(response.backend);
        } catch (error) {
          recoveryText = `Evaluator decision recovery failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const text = [response.text, recoveryText].filter(Boolean).join("\n\n");
      return decision
        ? { reviewer, status: "completed" as const, decision, text }
        : { reviewer, status: "control_missing" as const, decision: "unavailable" as const, text };
    }));
  }
}

function emptyChanges(workspace: string) {
  return { workspace, status: "", diff: "", changedFiles: [], deletedFiles: [] };
}

function emptyResult(sessionId: string, runId: string, workspace: string, placement: WorkspacePlacement, baseline: GitBaseline, plan?: DevelopmentPlan): DevelopmentRunResult {
  return { sessionId, runId, workspace, placement, iterations: 0, completed: false, changes: emptyChanges(workspace), evidence: [], reviews: [], ...(plan ? { plan } : {}), reviewStatus: "completed", baselineCommit: baseline.commit, baselineRepository: baseline.repository, sourceRoot: baseline.sourceRoot, delivery: { status: placement === "isolated" ? "pending" : "applied" } };
}
