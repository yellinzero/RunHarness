import { cp, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { DevelopmentRunResult } from "@runharness/shared";
import { runProcess } from "@runharness/providers";
import { captureWorkspaceCommit, inspectAuxiliaryWorktrees, updateWorkspaceRecord } from "./manager.js";

/** 只应用隔离结果明确记录的文件，并在写入前强制检查项目路径边界。 */
export async function applyDevelopmentResult(result: DevelopmentRunResult, projectDir: string, workspaceRoot: string): Promise<string[]> {
  if (result.placement !== "isolated") throw new Error("Only isolated results need to be applied");
  const root = path.resolve(projectDir);
  const workspace = await validateManagedWorkspace(result.workspace, workspaceRoot);
  for (const relative of result.changes.changedFiles) {
    inside(root, relative);
    await rejectSymlinkTraversal(root, relative);
    if (!result.changes.deletedFiles.includes(relative)) await rejectSymlinkTraversal(workspace, relative);
  }
  const auxiliaryWorktrees = await inspectAuxiliaryWorktrees(workspace);
  await updateWorkspaceRecord(path.dirname(path.resolve(workspaceRoot)), result.sessionId, { auxiliaryWorktrees });
  const unresolved = auxiliaryWorktrees.filter((item) => item.dirty || !item.integratedIntoPrimary);
  if (unresolved.length) throw new Error(`Apply is blocked by unresolved auxiliary worktrees: ${unresolved.map((item) => item.path).join(", ")}`);
  const currentSource = await captureWorkspaceCommit(result.baselineRepository, root, result.baselineCommit);
  const sourceChanges = await runProcess("git", ["--git-dir", result.baselineRepository, "diff", "--name-only", "-z", result.baselineCommit, currentSource], { cwd: root, timeoutMs: 30_000 });
  if (sourceChanges.code !== 0) throw new Error(`Could not preflight isolated delivery: ${sourceChanges.stderr || sourceChanges.stdout}`);
  const changedInSource = new Set(sourceChanges.stdout.split("\0").filter(Boolean));
  const conflicts = result.changes.changedFiles.filter((file) => changedInSource.has(file));
  if (conflicts.length) throw new Error(`Source changed after this Session began; resolve before Apply: ${conflicts.join(", ")}`);

  const runtimeRoot = path.dirname(path.resolve(workspaceRoot));
  await updateWorkspaceRecord(runtimeRoot, result.sessionId, { state: "delivering" });
  const transaction = await mkdtemp(path.join(runtimeRoot, "delivery-"));
  const staged = path.join(transaction, "staged");
  const backups = path.join(transaction, "backups");
  const existed = new Set<string>();
  const applied: string[] = [];
  try {
    for (const relative of result.changes.changedFiles) {
      const target = inside(root, relative);
      if (await lstat(target).catch(() => undefined)) { existed.add(relative); await mkdir(path.dirname(path.join(backups, relative)), { recursive: true }); await cp(target, path.join(backups, relative), { recursive: true }); }
      if (!result.changes.deletedFiles.includes(relative)) {
        const source = inside(workspace, relative);
        await mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
        await cp(source, path.join(staged, relative), { recursive: true });
      }
    }
    for (const relative of result.changes.changedFiles) {
      const target = inside(root, relative);
      // 首次修改前就登记路径，确保“删除旧文件、写入新文件”之间失败时仍能从事务备份恢复。
      applied.push(relative);
      await rm(target, { recursive: true, force: true });
      if (!result.changes.deletedFiles.includes(relative)) {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(staged, relative), target, { recursive: true });
      }
    }
  } catch (error) {
    for (const relative of [...applied].reverse()) {
      const target = inside(root, relative);
      await rm(target, { recursive: true, force: true });
      if (existed.has(relative)) { await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(backups, relative), target, { recursive: true }); }
    }
    await updateWorkspaceRecord(runtimeRoot, result.sessionId, { state: "retained" });
    throw error;
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
  return applied;
}

export async function discardDevelopmentResult(result: DevelopmentRunResult, workspaceRoot: string): Promise<void> {
  if (result.placement !== "isolated") throw new Error("In-place results cannot be discarded automatically");
  const workspace = await validateManagedWorkspace(result.workspace, workspaceRoot);
  await rm(path.dirname(workspace), { recursive: true, force: true });
  await updateWorkspaceRecord(path.dirname(path.resolve(workspaceRoot)), result.sessionId, { state: "removed" });
}

export async function removeAppliedDevelopmentWorkspace(result: DevelopmentRunResult, workspaceRoot: string): Promise<void> {
  if (result.placement !== "isolated") return;
  const workspace = await validateManagedWorkspace(result.workspace, workspaceRoot);
  await rm(path.dirname(workspace), { recursive: true, force: true });
  await updateWorkspaceRecord(path.dirname(path.resolve(workspaceRoot)), result.sessionId, { state: "removed" });
}

async function validateManagedWorkspace(workspace: string, workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(workspace);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(candidate) !== "primary" || path.dirname(candidate) === root)
    throw new Error("Isolated workspace is outside the managed Runtime workspace root");
  const runDirectory = path.dirname(candidate);
  try {
    const [realRoot, realRun, info] = await Promise.all([realpath(root), realpath(runDirectory), lstat(runDirectory)]);
    if (info.isSymbolicLink()) throw new Error("Isolated workspace run directory cannot be a symbolic link");
    const realRelative = path.relative(realRoot, realRun);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("Isolated workspace resolves outside the managed Runtime workspace root");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return candidate;
    throw error;
  }
  return candidate;
}

function inside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`Absolute result path is not allowed: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Result path escapes the project: ${relative}`);
  return resolved;
}

async function rejectSymlinkTraversal(root: string, relative: string): Promise<void> {
  let current = path.resolve(root);
  for (const segment of relative.replaceAll("\\", "/").split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Delivery path crosses a symbolic link: ${relative}`);
  }
}
