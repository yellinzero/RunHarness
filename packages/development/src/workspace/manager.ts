import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuxiliaryWorktreeState, ChangeSet, SessionWorkspaceRecord, WorkspaceAccess, WorkspacePlacement } from "@runharness/shared";
import { runProcess } from "@runharness/providers";

export interface GitBaseline {
  repository: string;
  commit: string;
  sourceRoot: string;
  placement: WorkspacePlacement;
}

export interface PreparedDevelopmentWorkspace {
  workspace: string;
  baseline: GitBaseline;
  sessionRoot?: string;
  auxiliaryRoot?: string;
}

/** Git 项目以仓库根为边界；非 Git 项目明确以启动目录为边界。 */
export async function resolveProjectRoot(source: string): Promise<string> {
  const requested = path.resolve(source);
  const repository = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: requested, timeoutMs: 10_000 });
  return repository.code === 0 ? path.resolve(repository.stdout.trim()) : requested;
}

/** 创建不可变 Git 基线；isolated 模式再创建由 Session 持有的主 worktree。 */
export async function prepareDevelopmentWorkspace(input: {
  source: string;
  placement: WorkspacePlacement;
  sessionId: string;
  workspaceRoot: string;
  runtimeRoot: string;
  access?: WorkspaceAccess;
  materializeIgnored?: string[];
}): Promise<PreparedDevelopmentWorkspace> {
  const sourceRoot = await resolveProjectRoot(input.source);
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const runtimeRelative = path.relative(sourceRoot, runtimeRoot);
  if (!runtimeRelative.startsWith("..") && !path.isAbsolute(runtimeRelative)) throw new Error("Runtime storage must be outside the source project");
  const cache = path.join(runtimeRoot, "git", "object-cache.git");
  await ensureBareRepository(cache, sourceRoot);
  const parent = await sourceHead(sourceRoot);
  if (parent) await fetchSourceHead(cache, sourceRoot, parent);
  const baselineCommit = await captureWorkspaceCommit(cache, sourceRoot, parent, input.materializeIgnored ?? []);
  const baseline: GitBaseline = { repository: cache, commit: baselineCommit, sourceRoot, placement: input.placement };
  const createdAt = new Date().toISOString();
  if (input.placement === "in_place") {
    await writeWorkspaceRecord(runtimeRoot, {
      sessionId: input.sessionId, placement: "in_place", access: input.access ?? "read_write", sourceRoot,
      repository: cache, baselineCommit, auxiliaryWorktrees: [], state: "ready", createdAt, updatedAt: createdAt,
    });
    return { workspace: sourceRoot, baseline };
  }

  const sessionRoot = path.join(path.resolve(input.workspaceRoot), input.sessionId);
  const primary = path.join(sessionRoot, "primary");
  const auxiliaryRoot = path.join(sessionRoot, "worktrees");
  await writeWorkspaceRecord(runtimeRoot, {
    sessionId: input.sessionId, placement: "isolated", access: input.access ?? "read_write", sourceRoot,
    repository: cache, baselineCommit, primaryPath: primary, auxiliaryRoot, auxiliaryWorktrees: [], state: "preparing", createdAt, updatedAt: createdAt,
  });
  await mkdir(sessionRoot, { recursive: true });
  // 普通本地 clone 通过硬链接复用不可变对象，同时保持 refs 和 worktree 注册表独立。
  // 不能使用 `--shared`：它会建立 alternates 依赖，缓存清理后对象可能被一并丢失。
  const cloned = await git(["clone", "--no-checkout", cache, primary], sourceRoot, 120_000);
  if (cloned.code !== 0) throw new Error(`Could not create Session Git repository: ${cloned.stderr || cloned.stdout}`);
  const checkedOut = await git(["checkout", "--detach", baselineCommit], primary, 120_000);
  if (checkedOut.code !== 0) throw new Error(`Could not create Session primary worktree: ${checkedOut.stderr || checkedOut.stdout}`);
  await git(["update-ref", "refs/runharness/baseline", baselineCommit], primary);
  await mkdir(auxiliaryRoot, { recursive: true });
  const repository = path.resolve(primary, (await git(["rev-parse", "--git-dir"], primary)).stdout.trim());
  await writeWorkspaceRecord(runtimeRoot, {
    sessionId: input.sessionId, placement: "isolated", access: input.access ?? "read_write", sourceRoot,
    repository, baselineCommit, primaryPath: primary, auxiliaryRoot, auxiliaryWorktrees: [], state: "ready", createdAt, updatedAt: new Date().toISOString(),
  });
  return { workspace: primary, sessionRoot, auxiliaryRoot, baseline: { ...baseline, repository } };
}

/** 只复用位于当前 Runtime Session 工作区根目录下的主 workspace。 */
export async function reuseDevelopmentWorkspace(input: {
  workspace: string;
  workspaceRoot: string;
  baselineCommit: string;
  sourceRoot: string;
}): Promise<PreparedDevelopmentWorkspace> {
  const candidate = path.resolve(input.workspace);
  const root = path.resolve(input.workspaceRoot);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(candidate) !== "primary")
    throw new Error("Continuation workspace is outside this project Runtime");
  const info = await stat(candidate).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error("The Session workspace is missing; RunHarness will not silently replace it");
  const repository = path.resolve(candidate, (await git(["rev-parse", "--git-dir"], candidate)).stdout.trim());
  return {
    workspace: candidate,
    sessionRoot: path.dirname(candidate),
    auxiliaryRoot: path.join(path.dirname(candidate), "worktrees"),
    baseline: { repository, commit: input.baselineCommit, sourceRoot: path.resolve(input.sourceRoot), placement: "isolated" },
  };
}

export async function collectRepositoryContext(workspace: string): Promise<string> {
  const candidates = ["README.md", "ARCHITECTURE.md", "package.json", "AGENTS.md"];
  const parts: string[] = [];
  for (const file of candidates) {
    try { parts.push(`## ${file}\n${(await readFile(path.join(workspace, file), "utf8")).slice(0, 12_000)}`); } catch { /* 可选项目上下文缺失不阻断规划。 */ }
  }
  const status = await git(["status", "--short"], workspace);
  parts.push(`## git status\n${status.stdout}`);
  return parts.join("\n\n");
}

export async function collectChangeSet(workspace: string, baseline: GitBaseline, maxChars = 120_000): Promise<ChangeSet> {
  const comparison = await captureWorkspaceCommit(baseline.repository, workspace, baseline.commit);
  const args = ["--git-dir", baseline.repository, "diff", "--no-ext-diff", "--binary", baseline.commit, comparison];
  const namesArgs = ["--git-dir", baseline.repository, "diff", "--name-status", "-z", baseline.commit, comparison];
  const [diffResult, namesResult] = await Promise.all([
    git(args, workspace, 30_000),
    git(namesArgs, workspace, 30_000),
  ]);
  if (diffResult.code !== 0) throw new Error(`Could not compare workspace: ${diffResult.stderr || diffResult.stdout}`);
  const records = parseNameStatus(namesResult.stdout);
  const changedFiles = records.map((item) => item.path);
  const deletedFiles = records.filter((item) => item.status.startsWith("D")).map((item) => item.path);
  const status = records.map((item) => `${item.status.padEnd(2)} ${item.path}`).join("\n");
  const diff = diffResult.stdout.length > maxChars ? `${diffResult.stdout.slice(0, maxChars)}\n... diff truncated ...` : diffResult.stdout;
  return { workspace, status, diff, changedFiles, deletedFiles };
}

async function ensureBareRepository(cache: string, sourceRoot: string): Promise<void> {
  if ((await stat(cache).catch(() => undefined))?.isDirectory()) return;
  await mkdir(path.dirname(cache), { recursive: true });
  const initialized = await git(["init", "--bare", cache], sourceRoot);
  if (initialized.code !== 0) throw new Error(`Could not initialize Runtime Git storage: ${initialized.stderr || initialized.stdout}`);
}

async function sourceHead(sourceRoot: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--verify", "HEAD"], sourceRoot);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function fetchSourceHead(cache: string, sourceRoot: string, head: string): Promise<void> {
  const fetched = await git(["--git-dir", cache, "fetch", "--force", "--no-tags", sourceRoot, `${head}:refs/runharness/source-head`], sourceRoot, 120_000);
  if (fetched.code !== 0) throw new Error(`Could not import source Git history: ${fetched.stderr || fetched.stdout}`);
}

export async function captureWorkspaceCommit(repository: string, workTree: string, parent?: string, materializeIgnored: string[] = []): Promise<string> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "runharness-index-"));
  const index = path.join(temporary, "index");
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "RunHarness",
    GIT_AUTHOR_EMAIL: "runtime@runharness.local",
    GIT_COMMITTER_NAME: "RunHarness",
    GIT_COMMITTER_EMAIL: "runtime@runharness.local",
  };
  try {
    const read = await git(["--git-dir", repository, parent ? "read-tree" : "read-tree", ...(parent ? [parent] : ["--empty"])], workTree, 30_000, environment);
    if (read.code !== 0) throw new Error(`Could not prepare Git baseline index: ${read.stderr || read.stdout}`);
    const added = await git(["--git-dir", repository, "--work-tree", workTree, "add", "-A", "--", "."], workTree, 120_000, environment);
    if (added.code !== 0) throw new Error(`Could not capture project files: ${added.stderr || added.stdout}`);
    for (const requested of materializeIgnored) {
      const relative = requested.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) throw new Error(`Ignored materialization path escapes the project: ${requested}`);
      const forced = await git(["--git-dir", repository, "--work-tree", workTree, "add", "-f", "-A", "--", relative], workTree, 120_000, environment);
      if (forced.code !== 0) throw new Error(`Could not materialize ignored path '${requested}': ${forced.stderr || forced.stdout}`);
    }
    const tree = await git(["--git-dir", repository, "write-tree"], workTree, 30_000, environment);
    if (tree.code !== 0) throw new Error(`Could not write Git baseline tree: ${tree.stderr || tree.stdout}`);
    const commit = await git(["--git-dir", repository, "commit-tree", tree.stdout.trim(), ...(parent ? ["-p", parent] : []), "-m", "RunHarness Session baseline"], workTree, 30_000, environment);
    if (commit.code !== 0) throw new Error(`Could not write Git baseline commit: ${commit.stderr || commit.stdout}`);
    return commit.stdout.trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseNameStatus(value: string): Array<{ status: string; path: string }> {
  const fields = value.split("\0").filter(Boolean);
  const records: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    const first = fields[index++] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const target = renamed ? fields[index++] ?? first : first;
    if (target) records.push({ status: status.slice(0, 1), path: target });
  }
  return records;
}

async function git(args: string[], cwd: string, timeoutMs = 30_000, env?: NodeJS.ProcessEnv) {
  return runProcess("git", args, { cwd, timeoutMs, ...(env ? { env } : {}) });
}

export async function readWorkspaceRecord(runtimeRoot: string, sessionId: string): Promise<SessionWorkspaceRecord | undefined> {
  try { return JSON.parse(await readFile(workspaceRecordPath(runtimeRoot, sessionId), "utf8")) as SessionWorkspaceRecord; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

export async function writeWorkspaceRecord(runtimeRoot: string, record: SessionWorkspaceRecord): Promise<void> {
  const file = workspaceRecordPath(runtimeRoot, record.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2));
  await rename(temporary, file);
}

export async function updateWorkspaceRecord(runtimeRoot: string, sessionId: string, update: Partial<Pick<SessionWorkspaceRecord, "state" | "updatedAt" | "auxiliaryWorktrees">>): Promise<SessionWorkspaceRecord | undefined> {
  const current = await readWorkspaceRecord(runtimeRoot, sessionId);
  if (!current) return undefined;
  const next = { ...current, ...update, updatedAt: update.updatedAt ?? new Date().toISOString() };
  await writeWorkspaceRecord(runtimeRoot, next);
  return next;
}

export async function inspectAuxiliaryWorktrees(primary: string): Promise<AuxiliaryWorktreeState[]> {
  const listed = await git(["worktree", "list", "--porcelain"], primary);
  if (listed.code !== 0) throw new Error(`Could not inspect Session worktrees: ${listed.stderr || listed.stdout}`);
  const primaryPath = await realpath(primary);
  const sessionRoot = path.dirname(primaryPath);
  const primaryHeadResult = await git(["rev-parse", "HEAD"], primaryPath);
  if (primaryHeadResult.code !== 0) throw new Error(`Could not inspect primary worktree HEAD: ${primaryHeadResult.stderr || primaryHeadResult.stdout}`);
  const primaryHead = primaryHeadResult.stdout.trim();
  const states: AuxiliaryWorktreeState[] = [];
  for (const block of listed.stdout.trim().split("\n\n")) {
    const lines = block.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) continue;
    const listedPath = path.resolve(worktreeLine.slice(9));
    const worktreePath = await realpath(listedPath).catch(() => listedPath);
    if (worktreePath === primaryPath) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    const dirtyResult = await git(["status", "--porcelain"], worktreePath);
    if (dirtyResult.code !== 0) throw new Error(`Could not inspect auxiliary worktree '${worktreePath}': ${dirtyResult.stderr || dirtyResult.stdout}`);
    const integrated = head ? (await git(["merge-base", "--is-ancestor", head, primaryHead], primaryPath)).code === 0 : false;
    const relative = path.relative(sessionRoot, worktreePath);
    states.push({ path: worktreePath, head, ...(branch ? { branch } : {}), dirty: Boolean(dirtyResult.stdout.trim()), integratedIntoPrimary: integrated, ownership: !relative.startsWith("..") && !path.isAbsolute(relative) ? "session" : "external" });
  }
  return states;
}

export async function deleteWorkspaceRecord(runtimeRoot: string, sessionId: string): Promise<void> {
  await rm(workspaceRecordPath(runtimeRoot, sessionId), { force: true });
}

export async function reconcileManagedWorkspaces(runtimeRoot: string, workspaceRoot: string, sessionIds: Set<string>): Promise<{ retained: number; missing: number; quarantined: number }> {
  const recordsDirectory = path.join(path.resolve(runtimeRoot), "workspace-records");
  const recordQuarantine = path.join(path.resolve(runtimeRoot), "quarantine", "workspace-records");
  const records = new Map<string, SessionWorkspaceRecord>();
  let retained = 0; let missing = 0; let quarantined = 0;
  await mkdir(recordsDirectory, { recursive: true }); await mkdir(recordQuarantine, { recursive: true });
  for (const name of await readdir(recordsDirectory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(recordsDirectory, name);
    try {
      const record = JSON.parse(await readFile(file, "utf8")) as SessionWorkspaceRecord;
      if (!record.sessionId || !record.sourceRoot || !record.baselineCommit) throw new Error("Incomplete workspace record");
      records.set(record.sessionId, record);
    } catch {
      await rename(file, path.join(recordQuarantine, `${name}-${Date.now()}`));
      quarantined += 1;
    }
  }
  for (const record of records.values()) {
    if (!sessionIds.has(record.sessionId) || record.placement !== "isolated" || record.state === "removed") continue;
    const primaryExists = record.primaryPath ? (await stat(record.primaryPath).catch(() => undefined))?.isDirectory() === true : false;
    if (!primaryExists) { missing += 1; await writeWorkspaceRecord(runtimeRoot, { ...record, state: "missing", updatedAt: new Date().toISOString() }); continue; }
    try {
      const auxiliaryWorktrees = await inspectAuxiliaryWorktrees(record.primaryPath!);
      await writeWorkspaceRecord(runtimeRoot, { ...record, state: record.state === "preparing" ? "ready" : record.state, auxiliaryWorktrees, updatedAt: new Date().toISOString() });
      retained += 1;
    } catch {
      missing += 1;
      await writeWorkspaceRecord(runtimeRoot, { ...record, state: "missing", updatedAt: new Date().toISOString() });
    }
  }
  const root = path.resolve(workspaceRoot);
  const quarantine = path.join(path.resolve(runtimeRoot), "quarantine", "workspaces");
  await mkdir(root, { recursive: true }); await mkdir(quarantine, { recursive: true });
  for (const name of await readdir(root)) {
    const candidate = path.join(root, name);
    const info = await lstat(candidate);
    const owned = records.get(name);
    if (info.isSymbolicLink() || !owned || !sessionIds.has(name)) {
      await rename(candidate, path.join(quarantine, `${name}-${Date.now()}`));
      quarantined += 1;
    }
  }
  return { retained, missing, quarantined };
}

function workspaceRecordPath(runtimeRoot: string, sessionId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(sessionId)) throw new Error("Invalid Session workspace identifier");
  return path.join(path.resolve(runtimeRoot), "workspace-records", `${sessionId}.json`);
}
