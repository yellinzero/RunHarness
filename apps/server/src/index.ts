import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  JsonlSessionStore,
  PromptRegistry,
  SessionMemoryStore,
} from "@runharness/core";
import { applyDevelopmentResult, classifyFailure, createExecutionRuntimes, deleteWorkspaceRecord, DevelopmentHarness, discardDevelopmentResult, reconcileManagedWorkspaces, removeAppliedDevelopmentWorkspace, resolveProjectRoot } from "@runharness/development";
import {
  AgentPool,
  builtinPermissionCatalog,
  loadModelConfig,
  permissionAllowRule,
  validateModelConfig,
  validateMcpServers,
} from "@runharness/providers";
import { defaultRuntimeSettings, validateMaxIterations, validateRuntimeSettings } from "@runharness/shared";
import type {
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  DevelopmentRunResult,
  HumanReviewDecision,
  ModelRoutingConfig,
  PlanDecisionRequest,
  StartSessionRequest,
  StartSessionResponse,
  StartRunRequest,
  StopSessionResponse,
  RuntimeSettings,
  UploadImageAttachmentRequest,
} from "@runharness/shared";
import { AttachmentStore } from "./attachments.js";
import { findProjectRuntime, listRuntimes, registerRuntime } from "./runtime-registry.js";
import { resolveProjectStorage } from "./project-storage.js";

export { defaultRunHarnessHome, resolveProjectStorage } from "./project-storage.js";
export { findProjectRuntime, listRuntimes, registerRuntime } from "./runtime-registry.js";

export interface ServerOptions {
  dataDir?: string;
  dashboardDir?: string;
  projectDir?: string;
  logger?: boolean;
  /** 测试或嵌入场景替换项目 Session 执行器的边界。 */
  sessionRunner?: (request: StartSessionRequest, sessionId: string, sessions: JsonlSessionStore, signal: AbortSignal) => Promise<unknown>;
}

export async function buildServer(options: ServerOptions = {}) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const storage = resolveProjectStorage(projectDir);
  const dataDir = path.resolve(options.dataDir ?? storage.dataDir);
  const progressDir = options.dataDir ? path.join(dataDir, "progress") : storage.progressDir;
  const workspacesDir = options.dataDir ? path.join(dataDir, "workspaces") : storage.workspacesDir;
  const attachments = new AttachmentStore(path.join(dataDir, "attachments"));
  await mkdir(dataDir, { recursive: true });
  const schemaPath = path.join(dataDir, "schema.json");
  const schema = await readFile(schemaPath, "utf8").then((value) => JSON.parse(value) as { version?: number }).catch(() => undefined);
  if (schema?.version !== 2) {
    for (const directory of ["sessions", "progress", "contexts", "workspaces", "workspace-records", "git", "scratch", "quarantine", "attachments"])
      await rm(path.join(dataDir, directory), { recursive: true, force: true });
    await writeFile(schemaPath, JSON.stringify({ version: 2, createdAt: new Date().toISOString() }, null, 2));
  }
  await attachments.initialize();
  await writeFile(path.join(dataDir, "project.json"), JSON.stringify({ id: storage.projectId, name: path.basename(projectDir), path: projectDir }, null, 2));
  const sessions = new JsonlSessionStore(dataDir, progressDir);
  const prompts = new PromptRegistry(dataDir);
  const liveProjectRuntime = options.dataDir ? undefined : await findProjectRuntime(projectDir, storage.home);
  // 只有确认不存在仍持有项目任务的存活 Runtime，才恢复遗留的运行中状态。
  if (!liveProjectRuntime) await sessions.failStaleRunning(0);
  await reconcileManagedWorkspaces(dataDir, workspacesDir, new Set((await sessions.listSessions()).map((session) => session.id)));
  const runtimePath = path.join(dataDir, "runtime.json");
  let runtimeSettings: RuntimeSettings = structuredClone(defaultRuntimeSettings);
  try {
    const saved = JSON.parse(await readFile(runtimePath, "utf8")) as Partial<RuntimeSettings>;
    runtimeSettings = {
      ...structuredClone(defaultRuntimeSettings),
      ...saved,
      maxIterations: saved.maxIterations === undefined ? defaultRuntimeSettings.maxIterations : validateMaxIterations(saved.maxIterations),
      executionPolicy: {
        ...defaultRuntimeSettings.executionPolicy,
        ...saved.executionPolicy,
        workspace: saved.executionPolicy?.workspace && typeof saved.executionPolicy.workspace === "object"
          ? { ...defaultRuntimeSettings.executionPolicy.workspace, ...saved.executionPolicy.workspace, materializeIgnored: saved.executionPolicy.workspace.materializeIgnored ?? [] }
          : defaultRuntimeSettings.executionPolicy.workspace,
        customRules: saved.executionPolicy?.customRules ?? [],
      },
      safetyClassifier: { ...defaultRuntimeSettings.safetyClassifier, ...saved.safetyClassifier },
    };
  } catch { /* 文件缺失或无效时使用已验证的默认配置。 */ }
  await prompts.initialize();
  const configPath = path.resolve(process.env.RUNHARNESS_CONFIG ?? path.join(dataDir, "config.json"));
  let modelConfig = await loadModelConfig(projectDir, configPath);
  let pool = new AgentPool(modelConfig, projectDir, dataDir);
  const developmentHarness = () => new DevelopmentHarness(pool, sessions, prompts, {
    acceptance: modelConfig.acceptance ?? [],
    ...(modelConfig.mcpServers ? { mcpServers: modelConfig.mcpServers } : {}),
    maxIterations: runtimeSettings.maxIterations,
    maxDiffChars: 120_000,
  });
  let agentStatus: AgentStatus[] = [];
  const rebuildRuntime = async () => {
    void pool.status().then((status) => { agentStatus = status; }).catch(() => undefined);
  };
  await rebuildRuntime();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 6 * 1024 * 1024 });
  const activeRuns = new Map<string, { controller: AbortController; task: Promise<unknown> }>();
  const activeApprovals = new Map<string, { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; reject: (error: Error) => void }>();
  const activeDeliveries = new Set<string>();
  const activeSteering = new Set<string>();
  const waitForApproval = (approval: ApprovalRequest, signal?: AbortSignal) => new Promise<ApprovalDecision>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    if (activeApprovals.has(approval.sessionId)) { reject(new Error("This Session already has a pending permission request")); return; }
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    activeApprovals.set(approval.sessionId, {
      request: approval,
      resolve: (decision) => { signal?.removeEventListener("abort", onAbort); resolve(decision); },
      reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
    });
  }).finally(() => { activeApprovals.delete(approval.sessionId); });
  const resumeWaitingRun = async (sessionId: string, result: DevelopmentRunResult, executionPolicy = runtimeSettings.executionPolicy) => {
    if (!result.plan || result.plan.status !== "approved") throw new Error("The Run has no approved Plan to resume");
    const session = await sessions.getSession(sessionId);
    const events = await sessions.getEvents(sessionId);
    const start = [...events].reverse().find((event) => event.runId === result.runId && event.type === "run_started");
    const payload = (start?.payload ?? {}) as Record<string, unknown>;
    const source = typeof payload.source === "string" ? payload.source : projectDir;
    const originalGoal = typeof payload.goal === "string" ? payload.goal : session.goal;
    const userInput = typeof payload.userInput === "string" ? payload.userInput : session.goal;
    const images = await attachments.selectForRun(sessionId, undefined, []);
    const controller = new AbortController();
    await sessions.setStatus(sessionId, "running");
    const task = developmentHarness().run({
      goal: userInput,
      originalGoal,
      source,
      workspaceRoot: workspacesDir,
      runtimeRoot: dataDir,
      contextRoot: path.join(dataDir, "contexts"),
      placement: result.placement,
      sessionId,
      images,
      signal: controller.signal,
      maxIterations: runtimeSettings.maxIterations,
      planReview: "auto",
      approvedPlan: result.plan,
      executionPolicy,
      safetyClassifier: runtimeSettings.safetyClassifier,
      requestApproval: waitForApproval,
      resumeWorkspace: result.workspace,
      baselineCommit: result.baselineCommit,
      baselineRepository: result.baselineRepository,
      sourceRoot: result.sourceRoot,
    });
    const tracked = task.finally(() => { activeRuns.delete(sessionId); });
    activeRuns.set(sessionId, { controller, task: tracked });
    void tracked.catch(() => undefined);
    return { sessionId, runId: result.runId, status: "running" as const, streamUrl: `/api/sessions/${sessionId}/stream` };
  };
  let registration: Awaited<ReturnType<typeof registerRuntime>> | undefined;
  app.addHook("onListen", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") return;
    registration = await registerRuntime(projectDir, `http://127.0.0.1:${address.port}`);
  });
  app.addHook("onClose", async () => {
    for (const run of activeRuns.values()) run.controller.abort();
    for (const approval of activeApprovals.values()) approval.reject(abortError());
    await Promise.allSettled([...activeRuns.values()].map((run) => run.task));
    await registration?.stop();
  });
  await app.register(cors, { origin: true });
  app.setErrorHandler((error, _request, reply) => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const statusCode =
      "statusCode" in normalized && typeof normalized.statusCode === "number"
        ? normalized.statusCode
        : "code" in normalized && normalized.code === "ENOENT" ? 404 : 500;
    return reply
      .code(statusCode)
      .send({
        error:
          normalized.message.length > 4000
            ? `${normalized.message.slice(0, 4000)}…`
            : normalized.message,
        type: normalized.name,
        statusCode,
      });
  });

  app.get("/api/health", async () => ({
    ok: true,
    mode: "project",
    agents: await pool.status(),
    dataDir,
    projectDir,
  }));
  app.get("/api/runtimes", async () => ({
    current: registration?.registration ?? null,
    runtimes: await listRuntimes(),
  }));
  app.get("/api/agents", async () => ({
    agents: await pool.status(),
    stages: modelConfig.stages,
  }));
  app.get("/api/models", async () => ({
    agents: await pool.models(),
  }));
  app.get("/api/mcp", async () => ({
    servers: await pool.mcpStatus(),
  }));
  app.get("/api/capabilities", async () => ({
    agents: pool.capabilityAgents(),
    runtimes: createExecutionRuntimes(modelConfig.mcpServers).map((runtime) => runtime.descriptor),
    acceptance: modelConfig.acceptance ?? [],
  }));
  app.get("/api/config", async () => ({
    config: modelConfig,
    configPath,
  }));
  app.get("/api/runtime", async () => runtimeSettings);
  app.get("/api/runtime/permission-catalog", async () => ({ entries: builtinPermissionCatalog }));
  app.put<{ Body: RuntimeSettings }>("/api/runtime", async (request, reply) => {
    if (request.body?.revision !== runtimeSettings.revision) return reply.code(409).send({ error: "Runtime settings changed; reload before saving", current: runtimeSettings });
    try { validateRuntimeSettings(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    if (request.body.safetyClassifier.enabled && !modelConfig.agents.some((agent) => agent.id === request.body.safetyClassifier.agentId && agent.enabled))
      return reply.code(400).send({ error: "Safety classifier Agent is missing or disabled" });
    runtimeSettings = { ...request.body, revision: runtimeSettings.revision + 1 };
    await writeFile(runtimePath, JSON.stringify(runtimeSettings, null, 2));
    return runtimeSettings;
  });
  app.post<{ Body: UploadImageAttachmentRequest }>("/api/attachments", async (request, reply) => {
    const attachment = await attachments.upload(request.body?.name, request.body?.data);
    return reply.code(201).send({ attachment });
  });
  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    await attachments.removeDraft(request.params.id);
    return reply.code(204).send();
  });
  app.put<{ Body: { config: ModelRoutingConfig } }>(
    "/api/config",
    async (request, reply) => {
      try { validateModelConfig(request.body?.config); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
      try { validateMcpServers(request.body.config.mcpServers); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
      await writeFile(configPath, JSON.stringify(request.body.config, null, 2));
      modelConfig = request.body.config;
      pool = new AgentPool(modelConfig, projectDir, dataDir);
      agentStatus = [];
      await rebuildRuntime();
      return { saved: true, configPath, agents: await pool.status() };
    },
  );
  app.get("/api/snapshot", async () => {
    const listed = await sessions.listSessions();
    const events = (
      await Promise.all(
        listed.slice(0, 20).map((session) => sessions.getEvents(session.id)),
      )
    )
      .flat()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-200);
    return {
      sessions: listed,
      events,
      prompts: await prompts.list(),
      agents: agentStatus,
    };
  });
  app.post<{ Body: StartSessionRequest }>("/api/sessions", async (request, reply) => {
    if (!request.body?.goal?.trim()) return reply.code(400).send({ error: "goal is required" });
    if (request.body.placement !== undefined && !["in_place", "isolated"].includes(request.body.placement)) return reply.code(400).send({ error: "placement must be in_place or isolated" });
    let parentSession;
    if (request.body.parentSessionId) {
      parentSession = await sessions.getSession(request.body.parentSessionId);
      if (parentSession.activeRunId || !["completed", "failed", "stopped"].includes(parentSession.status)) return reply.code(409).send({ error: "A linked Session requires a terminal parent Session" });
    }
    let maxIterations: number;
    try { maxIterations = request.body.maxIterations === undefined ? runtimeSettings.maxIterations : validateMaxIterations(request.body.maxIterations); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const prepared = await attachments.prepareClaim(request.body.attachmentIds ?? []);
    let session;
    try {
      session = await sessions.create(request.body.goal, parentSession?.id);
    } catch (error) {
      prepared.release();
      throw error;
    }
    let images;
    try {
      images = await prepared.claim(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sessions.emit(session.id, "system", "run_failed", { kind: "development", message, failure: classifyFailure(message) });
      await sessions.setStatus(session.id, "failed");
      const response: StartSessionResponse = { sessionId: session.id, runId: session.latestRunId, status: "failed", streamUrl: `/api/sessions/${session.id}/stream` };
      return reply.code(202).send(response);
    }
    const controller = new AbortController();
    const placement = request.body.placement ?? runtimeSettings.executionPolicy.workspace.placement;
    await sessions.setWorkspaceState(session.id, { workspacePlacement: placement, workspaceAccess: runtimeSettings.executionPolicy.workspace.access, deliveryStatus: placement === "isolated" ? "pending" : "live" });
    await sessions.setStatus(session.id, "running");
    const task = options.sessionRunner
      ? options.sessionRunner({ ...request.body, maxIterations }, session.id, sessions, controller.signal)
      : developmentHarness().run({
          goal: request.body.goal,
          source: path.resolve(request.body.source ?? projectDir),
          workspaceRoot: workspacesDir,
          runtimeRoot: dataDir,
          contextRoot: path.join(dataDir, "contexts"),
          placement,
          sessionId: session.id,
          ...(parentSession ? { previousSessionId: parentSession.id, originalGoal: parentSession.goal } : {}),
          images,
          signal: controller.signal,
          maxIterations,
          planReview: runtimeSettings.planReview,
          executionPolicy: runtimeSettings.executionPolicy,
          safetyClassifier: runtimeSettings.safetyClassifier,
          requestApproval: waitForApproval,
        });
    // HTTP 请求立即返回；后台 runner 负责持久化成功或失败终态。
    const tracked = task.catch(async (error) => {
      if (controller.signal.aborted && (await sessions.getSession(session.id)).status === "running") {
        await sessions.emit(session.id, "system", "run_stopped", { message: "Stopped by user" });
        await sessions.setStatus(session.id, "stopped");
      }
      throw error;
    }).finally(() => { activeRuns.delete(session.id); });
    activeRuns.set(session.id, { controller, task: tracked });
    void tracked.catch(() => undefined);
    const response: StartSessionResponse = { sessionId: session.id, runId: session.latestRunId, status: "running", streamUrl: `/api/sessions/${session.id}/stream` };
    return reply.code(202).send(response);
  });
  app.post<{ Params: { id: string }; Body: StartRunRequest }>("/api/sessions/:id/runs", async (request, reply) => {
    const parent = await sessions.getSession(request.params.id);
    if (parent.activeRunId || parent.status === "running" || parent.status === "idle") return reply.code(409).send({ error: "This Session already has an active Run" });
    if (!request.body?.message?.trim()) return reply.code(400).send({ error: "message is required" });
    let maxIterations: number;
    try { maxIterations = request.body.maxIterations === undefined ? runtimeSettings.maxIterations : validateMaxIterations(request.body.maxIterations); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const parentResult = await sessions.getResult<DevelopmentRunResult>(parent.id);
    const parentEvents = await sessions.getEvents(parent.id);
    const startEvent = [...parentEvents].reverse().find((event) => event.type === "run_started");
    const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
    const workspace = parentResult?.workspace ?? (typeof startPayload.workspace === "string" ? startPayload.workspace : "");
    const placement = parentResult?.placement ?? (startPayload.placement === "isolated" ? "isolated" : "in_place");
    const source = typeof startPayload.source === "string" ? startPayload.source : projectDir;
    const originalGoal = typeof startPayload.goal === "string" ? startPayload.goal : parent.goal;
    const run = await sessions.startRun(parent.id, request.body.message.trim());
    let images;
    try { images = await attachments.selectForRun(parent.id, request.body.selectedAttachmentIds, request.body.attachmentIds ?? []); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sessions.emit(parent.id, "system", "run_failed", { kind: "development", message, failure: classifyFailure(message) });
      await sessions.setStatus(parent.id, "failed");
      const response: StartSessionResponse = { sessionId: parent.id, runId: run.id, status: "failed", streamUrl: `/api/sessions/${parent.id}/stream` };
      return reply.code(202).send(response);
    }
    const controller = new AbortController();
    await sessions.setStatus(parent.id, "running");
    const runnerRequest: StartSessionRequest = { goal: request.body.message.trim(), source, placement, maxIterations, attachmentIds: request.body.attachmentIds ?? [] };
    const baselineCommit = parentResult?.baselineCommit ?? (typeof startPayload.baselineCommit === "string" ? startPayload.baselineCommit : undefined);
    const baselineRepository = parentResult?.baselineRepository ?? (typeof startPayload.baselineRepository === "string" ? startPayload.baselineRepository : undefined);
    const sourceRoot = parentResult?.sourceRoot ?? (typeof startPayload.sourceRoot === "string" ? startPayload.sourceRoot : undefined);
    const task = options.sessionRunner
      ? options.sessionRunner(runnerRequest, parent.id, sessions, controller.signal)
      : developmentHarness().run({ goal: request.body.message.trim(), originalGoal, source, workspaceRoot: workspacesDir, runtimeRoot: dataDir, contextRoot: path.join(dataDir, "contexts"), placement, sessionId: parent.id, images, signal: controller.signal, maxIterations, allowNetwork: request.body.allowNetwork === true, planReview: runtimeSettings.planReview, executionPolicy: runtimeSettings.executionPolicy, safetyClassifier: runtimeSettings.safetyClassifier, requestApproval: waitForApproval, ...(workspace ? { resumeWorkspace: workspace } : {}), ...(baselineCommit ? { baselineCommit } : {}), ...(baselineRepository ? { baselineRepository } : {}), ...(sourceRoot ? { sourceRoot } : {}) });
    const tracked = task.catch(async (error) => {
      if (controller.signal.aborted && (await sessions.getSession(parent.id)).status === "running") {
        await sessions.emit(parent.id, "system", "run_stopped", { message: "Stopped by user" });
        await sessions.setStatus(parent.id, "stopped");
      }
      throw error;
    }).finally(() => { activeRuns.delete(parent.id); });
    activeRuns.set(parent.id, { controller, task: tracked });
    void tracked.catch(() => undefined);
    const response: StartSessionResponse = { sessionId: parent.id, runId: run.id, status: "running", streamUrl: `/api/sessions/${parent.id}/stream` };
    return reply.code(202).send(response);
  });
  app.post<{ Params: { id: string }; Body: StartRunRequest & { requestId: string } }>("/api/sessions/:id/steer", async (request, reply) => {
    if (!request.body?.requestId?.trim() || !request.body.message?.trim()) return reply.code(400).send({ error: "requestId and message are required" });
    const parent = await sessions.getSession(request.params.id);
    const duplicate = (await sessions.getEvents(parent.id)).find((event) => event.type === "steer_requested" && (event.payload as { requestId?: string }).requestId === request.body.requestId);
    if (duplicate) return { sessionId: parent.id, runId: (await sessions.getSession(parent.id)).latestRunId, status: (await sessions.getSession(parent.id)).status, streamUrl: `/api/sessions/${parent.id}/stream` };
    if (parent.status !== "running" || !parent.activeRunId) return reply.code(409).send({ error: "Steer requires an active Run" });
    if (activeSteering.has(parent.id)) return reply.code(409).send({ error: "This Session is already steering" });
    activeSteering.add(parent.id);
    try {
      const parentEvents = await sessions.getEvents(parent.id);
      const startEvent = [...parentEvents].reverse().find((event) => event.type === "run_started");
      const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
      const parentResult = await sessions.getResult<DevelopmentRunResult>(parent.id);
      const images = await attachments.selectForRun(parent.id, request.body.selectedAttachmentIds, request.body.attachmentIds ?? []);
      await sessions.emit(parent.id, "human", "steer_requested", { requestId: request.body.requestId, message: request.body.message.trim(), attachmentIds: images.map((image) => image.id), fromRunId: parent.activeRunId });
      const active = activeRuns.get(parent.id);
      active?.controller.abort();
      await active?.task.catch(() => undefined);
      const checkpoint = await sessions.getResult<DevelopmentRunResult>(parent.id) ?? parentResult;
      if (!checkpoint) return reply.code(409).send({ error: "The active Run stopped before a workspace checkpoint was available" });
      const run = await sessions.startRun(parent.id, request.body.message.trim());
      const maxIterations = request.body.maxIterations === undefined ? runtimeSettings.maxIterations : validateMaxIterations(request.body.maxIterations);
      const source = typeof startPayload.source === "string" ? startPayload.source : checkpoint.sourceRoot;
      const originalGoal = typeof startPayload.goal === "string" ? startPayload.goal : parent.goal;
      const controller = new AbortController();
      await sessions.setStatus(parent.id, "running");
      const task = developmentHarness().run({
        goal: request.body.message.trim(), originalGoal, source, workspaceRoot: workspacesDir, runtimeRoot: dataDir,
        contextRoot: path.join(dataDir, "contexts"), placement: checkpoint.placement, sessionId: parent.id, images, signal: controller.signal,
        maxIterations, planReview: runtimeSettings.planReview, executionPolicy: runtimeSettings.executionPolicy,
        safetyClassifier: runtimeSettings.safetyClassifier, requestApproval: waitForApproval, resumeWorkspace: checkpoint.workspace,
        baselineCommit: checkpoint.baselineCommit, baselineRepository: checkpoint.baselineRepository, sourceRoot: checkpoint.sourceRoot,
      });
      const tracked = task.finally(() => { activeRuns.delete(parent.id); });
      activeRuns.set(parent.id, { controller, task: tracked });
      void tracked.catch(() => undefined);
      return reply.code(202).send({ sessionId: parent.id, runId: run.id, status: "running", streamUrl: `/api/sessions/${parent.id}/stream` });
    } finally { activeSteering.delete(parent.id); }
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request) => ({
    session: await sessions.getSession(request.params.id),
    runs: await sessions.listRuns(request.params.id),
    result: await sessions.getResult<DevelopmentRunResult>(request.params.id),
  }));
  app.post<{ Params: { id: string }; Body: PlanDecisionRequest }>("/api/sessions/:id/plan", async (request, reply) => {
    const session = await sessions.getSession(request.params.id);
    const result = await sessions.getResult<DevelopmentRunResult>(session.id);
    if (session.status !== "waiting_for_plan_approval" || !result?.plan) return reply.code(409).send({ error: "This Session is not waiting for Plan approval" });
    if (request.body.version !== result.plan.version) return reply.code(409).send({ error: "The Plan changed; reload before deciding", plan: result.plan });
    if (activeRuns.has(session.id)) return reply.code(409).send({ error: "This Run is already active" });
    if (request.body.decision === "revise") {
      const revised = request.body.revisedPlan?.trim();
      if (!revised) return reply.code(400).send({ error: "A revised Plan is required" });
      const plan = { ...result.plan, version: result.plan.version + 1, text: revised, status: "proposed" as const, updatedAt: new Date().toISOString() };
      await sessions.saveResult(session.id, { ...result, plan }, result.runId);
      await sessions.emit(session.id, "human", "plan_proposed", plan);
      return { plan, status: session.status };
    }
    if (request.body.decision === "reject") {
      const plan = { ...result.plan, status: "rejected" as const, updatedAt: new Date().toISOString() };
      await sessions.saveResult(session.id, { ...result, plan }, result.runId);
      await sessions.emit(session.id, "human", "plan_rejected", { version: plan.version, reason: request.body.reason ?? "Rejected by user" });
      await sessions.emit(session.id, "system", "run_stopped", { message: "Plan rejected by user" });
      await sessions.setStatus(session.id, "stopped");
      return { plan, status: "stopped" };
    }
    if (request.body.decision !== "approve") return reply.code(400).send({ error: "Invalid Plan decision" });
    const text = request.body.revisedPlan?.trim() || result.plan.text;
    const plan = { ...result.plan, text, status: "approved" as const, updatedAt: new Date().toISOString() };
    const approved = { ...result, plan };
    await sessions.saveResult(session.id, approved, result.runId);
    await sessions.emit(session.id, "human", "plan_approved", { version: plan.version, revised: text !== result.plan.text, reason: request.body.reason });
    return reply.code(202).send(await resumeWaitingRun(session.id, approved));
  });
  app.post<{ Params: { id: string }; Body: Omit<ApprovalDecision, "createdAt" | "actor"> }>("/api/sessions/:id/permissions", async (request, reply) => {
    const session = await sessions.getSession(request.params.id);
    const result = await sessions.getResult<DevelopmentRunResult>(session.id);
    const pending = result?.pendingApproval;
    if (session.status !== "waiting_for_permission" || !result || !pending) return reply.code(409).send({ error: "This Session is not waiting for permission approval" });
    if (request.body.requestId !== pending.id) return reply.code(409).send({ error: "The approval request changed; reload before deciding", approval: pending });
    const active = activeApprovals.get(session.id);
    if (!active || active.request.id !== pending.id) return reply.code(409).send({ error: "The live Provider permission request is no longer available" });
    const decision: ApprovalDecision = { ...request.body, actor: "human", createdAt: new Date().toISOString() };
    if (decision.decision === "approve" && decision.scope === "project") {
      const rule = permissionAllowRule(pending.action);
      runtimeSettings = { ...runtimeSettings, revision: runtimeSettings.revision + 1, executionPolicy: { ...runtimeSettings.executionPolicy, customRules: [rule, ...runtimeSettings.executionPolicy.customRules.filter((item) => item.id !== rule.id)] } };
      await writeFile(runtimePath, JSON.stringify(runtimeSettings, null, 2));
    }
    activeApprovals.delete(session.id);
    active.resolve(decision);
    return reply.code(202).send({ status: "running", decision });
  });
  app.get<{ Params: { id: string; runId: string } }>("/api/sessions/:id/runs/:runId", async (request) => ({
    run: await sessions.getRun(request.params.id, request.params.runId),
    result: await sessions.getResult<DevelopmentRunResult>(request.params.id, request.params.runId),
    events: (await sessions.getEvents(request.params.id)).filter((event) => event.runId === request.params.runId),
  }));
  app.get<{ Params: { id: string } }>("/api/sessions/:id/attachments", async (request) => {
    await sessions.getSession(request.params.id);
    return { attachments: await attachments.listSession(request.params.id) };
  });
  app.get<{ Params: { id: string; attachmentId: string } }>("/api/sessions/:id/attachments/:attachmentId", async (request, reply) => {
    await sessions.getSession(request.params.id);
    const { attachment, bytes } = await attachments.readSessionAttachment(request.params.id, request.params.attachmentId);
    return reply.type(attachment.mediaType).header("content-disposition", `inline; filename="${attachment.name.replaceAll('"', '')}"`).send(bytes);
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (request, reply) => {
    const session = await sessions.getSession(request.params.id);
    if (session.status !== "running" && session.status !== "waiting_for_permission") {
      const response: StopSessionResponse = { sessionId: session.id, status: session.status };
      return response;
    }
    const active = activeRuns.get(session.id);
    if (active) {
      await sessions.emit(session.id, "human", "message", { action: "stop_requested" });
      active.controller.abort();
    } else {
      await sessions.emit(session.id, "system", "run_stopped", { message: "Stopped after its Runtime execution handle was lost" });
      await sessions.setStatus(session.id, "stopped");
    }
    const response: StopSessionResponse = { sessionId: session.id, status: "stopped" };
    return reply.code(202).send(response);
  });
  app.post<{ Params: { id: string }; Body: { action: "apply" | "discard" } }>("/api/sessions/:id/result", async (request, reply) => {
    const session = await sessions.getSession(request.params.id);
    if (session.status === "running") return reply.code(409).send({ error: "Session is still running" });
    const result = await sessions.getResult<DevelopmentRunResult>(request.params.id);
    if (!result) return reply.code(404).send({ error: "Session has no development result" });
    if (request.body.action !== "apply" && request.body.action !== "discard") return reply.code(400).send({ error: "action must be apply or discard" });
    const requestedStatus = request.body.action === "apply" ? "applied" : "discarded";
    const currentStatus = result.delivery?.status ?? "pending";
    if (currentStatus === requestedStatus) return { action: requestedStatus, files: result.delivery?.files ?? [] };
    if (currentStatus !== "pending") return reply.code(409).send({ error: `Result was already ${currentStatus}` });
    if (activeDeliveries.has(session.id)) return reply.code(409).send({ error: "Result delivery is already in progress" });
    activeDeliveries.add(session.id);
    try {
      await sessions.emit(session.id, "human", "delivery_started", { action: request.body.action, workspace: result.workspace });
      const files = request.body.action === "apply" ? await applyDevelopmentResult(result, projectDir, workspacesDir) : [];
      if (request.body.action === "discard") await discardDevelopmentResult(result, workspacesDir);
      const delivered: DevelopmentRunResult = { ...result, delivery: { status: requestedStatus, updatedAt: new Date().toISOString(), files } };
      await sessions.saveResult(session.id, delivered);
      await sessions.emit(session.id, "human", "message", request.body.action === "apply" ? { action: "applied", files } : { action: "discarded", workspace: result.workspace });
      if (request.body.action === "apply") await removeAppliedDevelopmentWorkspace(delivered, workspacesDir);
      await sessions.setWorkspaceState(session.id, { workspacePlacement: "isolated", workspaceAccess: session.workspaceAccess ?? "read_write", deliveryStatus: requestedStatus });
      await sessions.emit(session.id, "system", "delivery_completed", { action: requestedStatus, files });
      return { action: requestedStatus, files };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/conflict|changed after|auxiliary worktree/i.test(message)) {
        await sessions.setWorkspaceState(session.id, { workspacePlacement: "isolated", workspaceAccess: session.workspaceAccess ?? "read_write", deliveryStatus: "conflict" });
        await sessions.emit(session.id, "system", "delivery_conflict", { message });
        return reply.code(409).send({ error: message });
      }
      throw error;
    } finally {
      activeDeliveries.delete(session.id);
    }
  });
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = await sessions.getSession(request.params.id);
    if (session.activeRunId || activeRuns.has(session.id) || activeDeliveries.has(session.id)) return reply.code(409).send({ error: "Stop the active Run or delivery before deleting this Session" });
    const runs = await sessions.listRuns(session.id);
    for (const run of runs) {
      const result = await sessions.getResult<DevelopmentRunResult>(session.id, run.id);
      if (result?.placement === "isolated") await discardDevelopmentResult(result, workspacesDir);
    }
    await attachments.deleteSession(session.id);
    await sessions.deleteSession(session.id);
    await deleteWorkspaceRecord(dataDir, session.id);
    const auditPath = path.join(dataDir, "deletions.jsonl");
    await appendFile(auditPath, `${JSON.stringify({ sessionId: session.id, deletedAt: new Date().toISOString(), local: true })}\n`);
    return reply.code(204).send();
  });
  app.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string };
  }>("/api/sessions/:id/events", async (request) =>
    sessions.getEvents(request.params.id, {
      offset: Number(request.query.offset ?? 0),
      limit: Number(request.query.limit ?? 200),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>(
    "/api/sessions/:id/stream",
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let offset = Number(request.query.offset ?? 0);
      let timer: NodeJS.Timeout | undefined;
      let closed = false;
      let lastHeartbeat = Date.now();
      const close = () => {
        closed = true;
        if (timer) clearTimeout(timer);
      };
      const send = async () => {
        if (closed) return;
        const events = await sessions.getEvents(request.params.id, { offset });
        for (const event of events) {
          reply.raw.write(
            `id: ${event.sequence}\nevent: harness-event\ndata: ${JSON.stringify(event)}\n\n`,
          );
          offset += 1;
        }
        const session = await sessions.getSession(request.params.id);
        if (["completed", "failed", "stopped"].includes(session.status)) {
          reply.raw.write(
            `event: end\ndata: ${JSON.stringify({ status: session.status })}\n\n`,
          );
          close();
          reply.raw.end();
          return;
        }
        if (Date.now() - lastHeartbeat >= 2_000) {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
          lastHeartbeat = Date.now();
        }
        timer = setTimeout(() => {
          void send().catch(() => {
            close();
            reply.raw.end();
          });
        }, 250);
      };
      request.raw.on("close", close);
      await send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/wake",
    async (request) => sessions.wake(request.params.id),
  );
  app.patch<{
    Params: { key: string };
    Body: { content: string; reason?: string };
  }>("/api/prompts/:key", async (request) =>
    prompts.update(
      request.params.key,
      request.body.content,
      request.body.reason,
    ),
  );
  app.post<{ Params: { key: string }; Body: { version: number } }>(
    "/api/prompts/:key/rollback",
    async (request) =>
      prompts.rollback(request.params.key, request.body.version),
  );
  app.get("/api/prompts/export", async (_request, reply) =>
    reply.type("application/json").send(await prompts.exportPreset()),
  );
  app.post<{
    Body: {
      eventId: string;
      decision: HumanReviewDecision["decision"];
      reason: string;
    };
  }>("/api/reviews", async (request, reply) => {
    const listed = await sessions.listSessions();
    const events = (await Promise.all(listed.map((session) => sessions.getEvents(session.id)))).flat();
    const verdict = events.find((event) => event.id === request.body.eventId && event.type === "verdict");
    if (!verdict) return reply.code(404).send({ error: "Review verdict was not found in this project" });
    const reason = request.body.reason?.trim();
    if (!reason) return reply.code(400).send({ error: "A human review note is required" });
    if (!(["accept", "reject", "add_evidence"] as const).includes(request.body.decision)) return reply.code(400).send({ error: "Invalid review decision" });
    if (events.some((event) => event.type === "human_reviewed" && (event.payload as Partial<HumanReviewDecision>).eventId === verdict.id))
      return reply.code(409).send({ error: "This review already has a human decision" });
    const verdictPayload = verdict.payload as Record<string, unknown>;
    const humanDecision: HumanReviewDecision = { eventId: verdict.id, decision: request.body.decision, reason, createdAt: new Date().toISOString() };
    await sessions.emit(verdict.sessionId, "human", "human_reviewed", humanDecision);
    const session = await sessions.getSession(verdict.sessionId);
    const memory = new SessionMemoryStore(dataDir);
    await memory.recordUserDecision(session.id, session.goal, `Human review ${humanDecision.decision}: ${humanDecision.reason}`, [{ type: "evidence", path: `../../events.jsonl#${verdict.id}` }]);
    const resolvesCurrent = verdictPayload.status === "control_missing" || verdictPayload.decision === "unavailable"
      ? humanDecision.decision === "accept"
      : verdictPayload.decision === "request_changes" && humanDecision.decision === "reject";
    if (resolvesCurrent) {
      const result = await sessions.getResult<DevelopmentRunResult>(verdict.sessionId, verdict.runId);
      if (result && result.evidence.filter((item) => item.requirement === "required").every((item) => item.status === "passed")) {
        const runVerdicts = events.filter((event) => event.sessionId === verdict.sessionId && event.runId === verdict.runId && event.type === "verdict");
        const decisionFor = (eventId: string) => eventId === verdict.id ? humanDecision.decision : (events.find((event) => event.type === "human_reviewed" && (event.payload as Partial<HumanReviewDecision>).eventId === eventId)?.payload as Partial<HumanReviewDecision> | undefined)?.decision;
        const blocking = runVerdicts.filter((event) => {
          const payload = event.payload as Record<string, unknown>;
          if (payload.decision === "accept") return false;
          return payload.status === "control_missing" || payload.decision === "unavailable" ? decisionFor(event.id) !== "accept" : decisionFor(event.id) !== "reject";
        });
        if (!blocking.length) {
          await sessions.saveResult(verdict.sessionId, { ...result, completed: true, reviewStatus: "completed" }, verdict.runId);
          if (session.latestRunId === verdict.runId && session.status !== "completed") {
            await sessions.emit(verdict.sessionId, "system", "run_completed", { completed: true, by: "human_review", eventId: verdict.id });
            await sessions.setStatus(verdict.sessionId, "completed");
          }
        }
      }
    }
    return humanDecision;
  });

  // Dashboard 资源属于 RunHarness 安装包，不属于当前被观察的项目。
  const bundledDashboard = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
  const dashboardDir = path.resolve(options.dashboardDir ?? bundledDashboard);
  try {
    await access(dashboardDir);
    app.get("/", async (_request, reply) => reply.type("text/html").send(await readFile(path.join(dashboardDir, "index.html"))));
    app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
      const relative = request.params["*"];
      if (!relative || relative.includes("..") || path.isAbsolute(relative)) return reply.code(400).send({ error: "Invalid asset path" });
      const file = path.join(dashboardDir, "assets", relative);
      const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
      return reply.type(contentType).send(await readFile(file));
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : readFile(path.join(dashboardDir, "index.html")).then((html) => reply.type("text/html").send(html)),
    );
  } catch {
    app.get("/", async () => ({
      name: "RunHarness API",
      dashboard: "Run pnpm build to build the dashboard.",
    }));
  }
  return app;
}

function abortError(): Error { const error = new Error("Run interrupted"); error.name = "AbortError"; return error; }

export async function startServer(
  port = Number(process.env.RUNHARNESS_PORT ?? 8888),
  project = process.cwd(),
  dashboardDir?: string,
) {
  const projectDir = await resolveProjectRoot(project);
  const app = await buildServer({ logger: true, projectDir, ...(dashboardDir ? { dashboardDir } : {}) });
  try {
    await app.listen({ port, host: "127.0.0.1" });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
