import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId, type Actor, type EventType, type HarnessEvent, type RunRecord, type SessionRecord, type SessionStatus } from "@runharness/shared";

export interface EventSlice { offset?: number; limit?: number }

const terminalStatuses = new Set<SessionStatus>(["completed", "failed", "stopped"]);

/** 持久化、只追加的会话存储；Session 可继续，Run 是其中一次必须到达终态的执行。 */
export class JsonlSessionStore {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly rootDir: string, private readonly progressDir?: string) {}

  private sessionDir(id: string): string {
    if (!/^session_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Session ID");
    return path.join(this.rootDir, "sessions", id);
  }
  private metaPath(id: string): string { return path.join(this.sessionDir(id), "session.json"); }
  private eventsPath(id: string): string { return path.join(this.sessionDir(id), "events.jsonl"); }
  private runsDir(id: string): string { return path.join(this.sessionDir(id), "runs"); }
  private runDir(sessionId: string, runId: string): string {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid Run ID");
    return path.join(this.runsDir(sessionId), runId);
  }
  private runPath(sessionId: string, runId: string): string { return path.join(this.runDir(sessionId, runId), "run.json"); }
  private resultPath(sessionId: string, runId: string): string { return path.join(this.runDir(sessionId, runId), "result.json"); }

  async create(goal: string, parentSessionId?: string): Promise<SessionRecord> {
    const id = createId("session");
    const run = this.newRun(id, goal);
    const now = run.createdAt;
    const session: SessionRecord = {
      id,
      goal,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
      runCount: 1,
      latestRunId: run.id,
      ...(parentSessionId ? { parentSessionId } : {}),
      activeRunId: run.id,
      workspacePlacement: "in_place",
      workspaceAccess: "read_write",
      deliveryStatus: "live",
    };
    await mkdir(this.runDir(id, run.id), { recursive: true });
    await Promise.all([
      writeJson(this.metaPath(id), session),
      writeJson(this.runPath(id, run.id), run),
      writeFile(this.eventsPath(id), ""),
    ]);
    await this.writeProgress(session, [], [run]);
    return session;
  }

  async startRun(sessionId: string, message: string): Promise<RunRecord> {
    const session = await this.getSession(sessionId);
    if (session.activeRunId) throw new Error(`Session already has an active Run '${session.activeRunId}'`);
    const run = this.newRun(sessionId, message);
    const next: SessionRecord = {
      ...session,
      status: "idle",
      updatedAt: run.createdAt,
      runCount: session.runCount + 1,
      latestRunId: run.id,
      activeRunId: run.id,
    };
    await mkdir(this.runDir(sessionId, run.id), { recursive: true });
    await writeJson(this.runPath(sessionId, run.id), run);
    await writeJson(this.metaPath(sessionId), next);
    await this.writeProgress(next, await this.getEvents(sessionId), await this.listRuns(sessionId));
    return run;
  }

  async getSession(id: string): Promise<SessionRecord> {
    return readJson<SessionRecord>(this.metaPath(id));
  }

  async setWorkspaceState(sessionId: string, state: Pick<SessionRecord, "workspacePlacement" | "workspaceAccess" | "deliveryStatus">): Promise<SessionRecord> {
    return this.enqueue(sessionId, async () => {
      const session = await this.getSession(sessionId);
      const next = { ...session, ...state, updatedAt: new Date().toISOString() };
      await writeJson(this.metaPath(sessionId), next);
      await this.writeProgress(next, await this.getEvents(sessionId), await this.listRunsWithoutMigration(sessionId));
      return next;
    });
  }

  async getRun(sessionId: string, runId?: string): Promise<RunRecord> {
    const session = await this.getSession(sessionId);
    return readJson<RunRecord>(this.runPath(sessionId, runId ?? session.latestRunId));
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    await this.getSession(sessionId);
    const ids = await readdir(this.runsDir(sessionId));
    const runs = await Promise.all(ids.map(async (id) => readJson<RunRecord>(this.runPath(sessionId, id))));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listSessions(): Promise<SessionRecord[]> {
    const dir = path.join(this.rootDir, "sessions");
    await mkdir(dir, { recursive: true });
    const ids = await readdir(dir);
    const sessions = await Promise.all(ids.map(async (id) => this.getSession(id)));
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async setStatus(id: string, status: SessionStatus): Promise<SessionRecord> {
    return this.enqueue(id, async () => {
      const session = await this.getSession(id);
      const runId = session.activeRunId ?? session.latestRunId;
      const run = await this.getRun(id, runId);
      const now = new Date().toISOString();
      const nextRun: RunRecord = { ...run, status, updatedAt: now };
      const sessionWithoutActiveRun = { ...session };
      delete sessionWithoutActiveRun.activeRunId;
      const next: SessionRecord = {
        ...sessionWithoutActiveRun,
        status,
        updatedAt: now,
        ...(!terminalStatuses.has(status) ? { activeRunId: runId } : {}),
      };
      await writeJson(this.runPath(id, runId), nextRun);
      await this.writeProgress(next, await this.getEvents(id), await this.listRunsWithoutMigration(id));
      await writeJson(this.metaPath(id), next);
      return next;
    });
  }

  async setIterationCount(sessionId: string, iterationCount: number): Promise<void> {
    const session = await this.getSession(sessionId);
    const runId = session.activeRunId ?? session.latestRunId;
    const run = await this.getRun(sessionId, runId);
    await writeJson(this.runPath(sessionId, runId), { ...run, iterationCount, updatedAt: new Date().toISOString() });
  }

  async emit<T>(sessionId: string, actor: Actor, type: EventType, payload: T): Promise<HarnessEvent<T>> {
    return this.enqueue(sessionId, async () => {
      const session = await this.getSession(sessionId);
      const runId = session.activeRunId ?? session.latestRunId;
      const emitted: HarnessEvent<T> = { id: createId("event"), sessionId, runId, sequence: session.eventCount, timestamp: new Date().toISOString(), actor, type, payload };
      await appendFile(this.eventsPath(sessionId), `${JSON.stringify(emitted)}\n`);
      const updated = { ...session, eventCount: session.eventCount + 1, updatedAt: emitted.timestamp };
      await writeJson(this.metaPath(sessionId), updated);
      await this.writeProgress(updated, await this.getEvents(sessionId), await this.listRunsWithoutMigration(sessionId));
      return emitted;
    });
  }

  async getEvents(id: string, slice: EventSlice = {}): Promise<HarnessEvent[]> {
    await this.getSession(id);
    const raw = await readFile(this.eventsPath(id), "utf8");
    const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HarnessEvent);
    const offset = Math.max(0, slice.offset ?? 0);
    return events.slice(offset, slice.limit === undefined ? undefined : offset + Math.max(0, slice.limit));
  }

  async saveResult<T>(id: string, result: T, runId?: string): Promise<void> {
    const session = await this.getSession(id);
    await writeJson(this.resultPath(id, runId ?? session.activeRunId ?? session.latestRunId), result);
  }

  async getResult<T>(id: string, runId?: string): Promise<T | undefined> {
    try {
      const session = await this.getSession(id);
      return await readJson<T>(this.resultPath(id, runId ?? session.activeRunId ?? session.latestRunId));
    } catch { return undefined; }
  }

  async wake(id: string): Promise<{ session: SessionRecord; events: HarnessEvent[]; runs: RunRecord[] }> {
    return { session: await this.getSession(id), events: await this.getEvents(id), runs: await this.listRuns(id) };
  }

  async deleteSession(id: string): Promise<void> {
    const session = await this.getSession(id);
    if (session.activeRunId || session.status === "running" || session.status === "idle") throw new Error("Stop the active Run before deleting this Session");
    await rm(this.sessionDir(id), { recursive: true, force: true });
    if (this.progressDir) await rm(path.join(this.progressDir, `${id}.md`), { force: true });
  }

  async failStaleRunning(maxAgeMs = 6 * 60 * 60 * 1000): Promise<string[]> {
    const stale = (await this.listSessions()).filter((session) => session.status === "running" && Date.now() - Date.parse(session.updatedAt) >= maxAgeMs);
    for (const session of stale) {
      await this.emit(session.id, "system", "run_failed", { message: "Runtime stopped before the Run reached a terminal state", recoveredAt: new Date().toISOString() });
      await this.setStatus(session.id, "failed");
    }
    return stale.map((session) => session.id);
  }

  private newRun(sessionId: string, message: string): RunRecord {
    const now = new Date().toISOString();
    return { id: createId("run"), sessionId, message, status: "idle", createdAt: now, updatedAt: now, iterationCount: 0 };
  }

  private async listRunsWithoutMigration(sessionId: string): Promise<RunRecord[]> {
    const ids = await readdir(this.runsDir(sessionId));
    const runs = await Promise.all(ids.map(async (id) => readJson<RunRecord>(this.runPath(sessionId, id))));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async writeProgress(session: SessionRecord, events: HarnessEvent[], runs: RunRecord[]): Promise<void> {
    if (!this.progressDir) return;
    await mkdir(this.progressDir, { recursive: true });
    const recent = events.slice(-20).map((event) => `- ${event.timestamp} [${event.runId}/${event.actor}] ${event.type}: ${progressPayload(event.payload)}`).join("\n");
    const runLines = runs.map((run) => `- ${run.id}: ${run.status} · ${run.message.replaceAll("\n", " ").slice(0, 160)}`).join("\n");
    await writeFile(path.join(this.progressDir, `${session.id}.md`), `# RunHarness session\n\n- Session: ${session.id}\n- Goal: ${session.goal}\n- Latest status: ${session.status}\n- Active Run: ${session.activeRunId ?? "none"}\n- Updated: ${session.updatedAt}\n- Runs: ${session.runCount}\n- Events: ${session.eventCount}\n\n## Runs\n\n${runLines || "- No Runs."}\n\n## Latest progress\n\n${recent || "- Session created; waiting to start."}\n`);
  }

  private async enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    // 同一 Session 的事件序号、Run 状态和进度文件必须串行提交，不同 Session 仍可并行运行。
    const previous = this.mutationQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.mutationQueues.set(sessionId, next);
    try { return await next; }
    finally { if (this.mutationQueues.get(sessionId) === next) this.mutationQueues.delete(sessionId); }
  }
}

function progressPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const item = payload as Record<string, unknown>;
  const value = item.message ?? item.summary ?? item.plan ?? item.action ?? item.goal ?? item.evidence ?? item;
  return (typeof value === "string" ? value : JSON.stringify(value)).replaceAll("\n", " ").slice(0, 500);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  // 先写同目录临时文件再 rename，避免进程中断留下半截 JSON；Windows 冲突时再执行受控替换。
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  try { await rename(temporary, file); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "EPERM")) {
      await rm(file, { force: true });
      await rename(temporary, file);
    } else {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

async function readJson<T>(file: string): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return JSON.parse(await readFile(file, "utf8")) as T; }
    catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, attempt + 1)); }
  }
  throw failure;
}
