import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DevelopmentRunResult, RunRecord } from "@runharness/shared";

export type MemoryEntryKind = "run_outcome" | "user_decision";
export type MemoryEntryStatus = "active" | "resolved";

export interface MemoryReference {
  type: "episode" | "source" | "evidence";
  path: string;
  anchor?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryEntryKind;
  status: MemoryEntryStatus;
  importance: number;
  summary: string;
  createdAt: string;
  runId?: string;
  iteration?: number;
  files: string[];
  tags: string[];
  references: MemoryReference[];
  supersedes: string[];
}

export interface MemoryIndex {
  version: 1;
  entries: MemoryEntry[];
}

export interface ContextPacketRequest {
  sessionId: string;
  runId: string;
  stage: "planner" | "generator" | "evaluator";
  goal: string;
  userRequest: string;
  workspace: string;
  budgetChars: number;
  currentEvidence?: string;
  nextAction: string;
}

/** Runtime 持有的文件优先记忆；完整事件和类型化结果始终是事实来源。 */
export class SessionMemoryStore {
  constructor(private readonly runtimeRoot: string) {}

  async initialize(sessionId: string, goal: string): Promise<void> {
    const directory = this.memoryDir(sessionId);
    await Promise.all([mkdir(this.episodesDir(sessionId), { recursive: true }), mkdir(this.contextsDir(sessionId), { recursive: true })]);
    try { await readFile(this.indexPath(sessionId)); }
    catch {
      await this.writeIndex(sessionId, { version: 1, entries: [] });
      await writeFile(path.join(directory, "session.md"), renderSessionMemory(goal, []));
    }
  }

  async recordRun(sessionId: string, goal: string, run: RunRecord, result: DevelopmentRunResult, failureMessage?: string): Promise<string> {
    await this.initialize(sessionId, goal);
    const episodeRelative = path.join("episodes", `${run.id}.md`);
    const episodePath = path.join(this.memoryDir(sessionId), episodeRelative);
    const blockingEvidence = result.evidence.filter((item) => item.blocksCompletion);
    const issues = result.reviews.filter((item) => item.decision === "request_changes").map((item) => item.text);
    const outcome = result.completed ? "completed" : run.status;
    const episode = `# Run ${run.id}\n\n## User input\n\n${run.message}\n\n## Outcome\n\n- Status: ${outcome}\n- Iterations: ${result.iterations}\n- Workspace placement: ${result.placement}\n- Review status: ${result.reviewStatus ?? "completed"}\n\n## Changes\n\n${result.changes.changedFiles.map((file) => `- ${file}`).join("\n") || "- No changed files."}\n\n## Blocking acceptance evidence\n\n${blockingEvidence.map((item) => `- ${item.capability} on ${item.runtimeId ?? item.placement}: ${item.status}\n  - ${bounded(item.summary, 2_000)}`).join("\n") || "- None."}\n\n## Review issues\n\n${issues.map((issue) => `- ${issue}`).join("\n") || "- None."}\n\n## Failure reason\n\n${failureMessage ?? (result.completed ? "None." : "The Run did not satisfy required acceptance and review.")}\n\n## Evidence\n\n- Run result: ../../runs/${run.id}/result.json\n- Session events: ../../events.jsonl\n`;
    await writeFile(episodePath, episode);

    const index = await this.readIndex(sessionId);
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `run:${run.id}`,
      kind: "run_outcome",
      status: result.completed ? "resolved" : "active",
      importance: result.completed ? 55 : 90,
      summary: result.completed
        ? `Run completed after ${result.iterations} iteration(s); changed ${result.changes.changedFiles.length} file(s).`
        : `Run failed after ${result.iterations} iteration(s): ${failureMessage ?? (blockingEvidence.map((item) => item.capability).join(", ") || issues[0] || "acceptance was not met")}.`,
      createdAt: now,
      runId: run.id,
      iteration: result.iterations,
      files: result.changes.changedFiles,
      tags: unique([run.status, result.placement, ...blockingEvidence.map((item) => item.capability), ...result.changes.changedFiles.flatMap(pathTags)]),
      references: [{ type: "episode", path: episodeRelative }],
      supersedes: [],
    };
    const previous = index.entries.filter((item) => item.id !== entry.id).map((item) => result.completed && item.kind === "run_outcome" && item.status === "active" ? { ...item, status: "resolved" as const, supersedes: [...item.supersedes, entry.id] } : item);
    const entries = [...previous, entry].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await this.writeIndex(sessionId, { version: 1, entries });
    await writeFile(path.join(this.memoryDir(sessionId), "session.md"), renderSessionMemory(goal, entries));
    return episodePath;
  }

  async recordUserDecision(sessionId: string, goal: string, summary: string, references: MemoryReference[] = []): Promise<void> {
    await this.initialize(sessionId, goal);
    const index = await this.readIndex(sessionId);
    const entry: MemoryEntry = {
      id: `decision:${Date.now().toString(36)}`,
      kind: "user_decision",
      status: "active",
      importance: 100,
      summary,
      createdAt: new Date().toISOString(),
      files: [],
      tags: tokenize(summary),
      references,
      supersedes: [],
    };
    const entries = [...index.entries, entry];
    await this.writeIndex(sessionId, { version: 1, entries });
    await writeFile(path.join(this.memoryDir(sessionId), "session.md"), renderSessionMemory(goal, entries));
  }

  async assemble(request: ContextPacketRequest): Promise<{ filePath: string; content: string; selected: MemoryEntry[] }> {
    await this.initialize(request.sessionId, request.goal);
    const [memory, index] = await Promise.all([
      readFile(path.join(this.memoryDir(request.sessionId), "session.md"), "utf8"),
      this.readIndex(request.sessionId),
    ]);
    const terms = new Set(tokenize(`${request.userRequest} ${request.currentEvidence ?? ""}`));
    const selected = index.entries
      .filter((entry) => entry.status === "active" || entry.kind === "user_decision" || entry.runId === request.runId)
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt))
      .slice(0, 6)
      .map((item) => item.entry);
    const references = selected.flatMap((entry) => entry.references.map((reference) => `- ${entry.summary}\n  - ${reference.path}${reference.anchor ? `#${reference.anchor}` : ""}`)).join("\n");
    const content = bounded(`# RunHarness Agent Context\n\n- Session: ${request.sessionId}\n- Run: ${request.runId}\n- Stage: ${request.stage}\n- Workspace: ${request.workspace}\n\n## Current user request\n\n${request.userRequest}\n\n## Session memory\n\n${memory}\n\n## Selected references\n\n${references || "- No earlier Episode is needed."}\n\n## Current evidence\n\n${request.currentEvidence ?? "No current evidence yet."}\n\n## Next action\n\n${request.nextAction}\n\nRead only the referenced evidence needed for this stage. Inspect current repository files before trusting an older summary.`, Math.max(4_000, request.budgetChars));
    const directory = path.join(this.contextsDir(request.sessionId), request.runId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${request.stage}.md`);
    await writeFile(filePath, content);
    return { filePath, content, selected };
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertId(sessionId);
    // 上层 SessionStore 持有父目录，删除 Session 时会连同 Memory 一并清理。
  }

  private sessionDir(sessionId: string): string { assertId(sessionId); return path.join(this.runtimeRoot, "sessions", sessionId); }
  private memoryDir(sessionId: string): string { return path.join(this.sessionDir(sessionId), "memory"); }
  private episodesDir(sessionId: string): string { return path.join(this.memoryDir(sessionId), "episodes"); }
  private contextsDir(sessionId: string): string { return path.join(this.sessionDir(sessionId), "contexts"); }
  private indexPath(sessionId: string): string { return path.join(this.memoryDir(sessionId), "index.json"); }
  private async readIndex(sessionId: string): Promise<MemoryIndex> { return JSON.parse(await readFile(this.indexPath(sessionId), "utf8")) as MemoryIndex; }
  private async writeIndex(sessionId: string, index: MemoryIndex): Promise<void> { await mkdir(this.memoryDir(sessionId), { recursive: true }); await writeFile(this.indexPath(sessionId), JSON.stringify(index, null, 2)); }
}

function renderSessionMemory(goal: string, entries: MemoryEntry[]): string {
  const decisions = entries.filter((entry) => entry.kind === "user_decision" && entry.status === "active");
  const unresolved = entries.filter((entry) => entry.kind === "run_outcome" && entry.status === "active").slice(-5);
  const completed = entries.filter((entry) => entry.kind === "run_outcome" && entry.status === "resolved").slice(-5);
  const files = unique(entries.slice(-8).flatMap((entry) => entry.files)).slice(-20);
  const latest = entries.at(-1);
  return `# Session Memory\n\n## Goal\n\n${goal}\n\n## User decisions\n\n${list(decisions)}\n\n## Current state\n\n${latest?.summary ?? "No Run has completed yet."}\n\n## Completed\n\n${list(completed)}\n\n## Unresolved\n\n${list(unresolved)}\n\n## Failed approaches\n\n${list(unresolved)}\n\n## Important files\n\n${files.map((file) => `- ${file}`).join("\n") || "- None recorded yet."}\n\n## Next action\n\n${unresolved.at(-1)?.summary ?? "Continue the current user request and verify it."}\n`;
}

function list(entries: MemoryEntry[]): string { return entries.map((entry) => `- ${entry.summary}\n  - Reference: ${entry.references[0]?.path ?? "events.jsonl"}`).join("\n") || "- None."; }
function scoreEntry(entry: MemoryEntry, terms: Set<string>): number { return entry.importance + tokenize(`${entry.summary} ${entry.tags.join(" ")} ${entry.files.join(" ")}`).filter((term) => terms.has(term)).length * 20 + (entry.status === "active" ? 25 : 0); }
function tokenize(value: string): string[] { return unique(value.toLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((term) => term.length > 1)); }
function pathTags(value: string): string[] { return value.split(/[\\/._-]+/).filter((part) => part.length > 1); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function bounded(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}\n… truncated; follow references for omitted evidence …` : value; }
function assertId(id: string): void { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Session ID"); }
