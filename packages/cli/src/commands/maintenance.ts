import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveProjectRoot } from "@runharness/development";
import { defaultRunHarnessHome, listRuntimes, resolveProjectStorage } from "@runharness/server";

export interface DataSummary {
  label: string;
  directory: string;
  bytes: number;
  sessions: number;
  categories: Record<string, number>;
}

export async function describeData(all: boolean, project = process.cwd(), home = defaultRunHarnessHome()): Promise<DataSummary> {
  if (all) return summarize("All RunHarness data", home);
  const projectDir = await resolveProjectRoot(project);
  const storage = resolveProjectStorage(projectDir, home);
  return summarize(path.basename(projectDir), storage.dataDir);
}

export async function cleanData(options: { all: boolean; yes: boolean; project?: string; home?: string; confirm?: (question: string) => Promise<boolean> }): Promise<DataSummary | undefined> {
  const project = options.project ?? process.cwd();
  const home = options.home ?? defaultRunHarnessHome();
  const summary = await describeData(options.all, project, home);
  if (summary.bytes === 0) return undefined;
  const runtimes = await listRuntimes(home);
  const projectDir = options.all ? undefined : await resolveProjectRoot(project);
  // 删除前检查真实存活 Runtime，避免正在追加 JSONL 或操作 workspace 时破坏数据。
  const active = options.all ? runtimes : runtimes.filter((runtime) => runtime.projectDir === projectDir);
  if (active.length) throw new Error(`Stop active RunHarness Runtime${active.length > 1 ? "s" : ""} before deleting data`);
  const approved = options.yes || await (options.confirm ?? confirmInTerminal)(`Delete ${summary.label} (${formatBytes(summary.bytes)}, ${summary.sessions} sessions) from ${summary.directory}?`);
  if (!approved) return undefined;
  await rm(summary.directory, { recursive: true, force: true });
  return summary;
}

export function formatSummary(summary: DataSummary): string {
  const categories = Object.entries(summary.categories).filter(([, bytes]) => bytes > 0).map(([name, bytes]) => `  ${name}: ${formatBytes(bytes)}`).join("\n");
  return `${summary.label}\nPath: ${summary.directory}\nSessions: ${summary.sessions}\nSize: ${formatBytes(summary.bytes)}${categories ? `\nStorage:\n${categories}` : ""}`;
}

async function summarize(label: string, directory: string): Promise<DataSummary> {
  const bytes = await directorySize(directory);
  let sessions = 0;
  const categories: Record<string, number> = { sessions: 0, workspaces: 0, git: 0, attachments: 0, scratch: 0, quarantine: 0, other: 0 };
  if (label === "All RunHarness data") {
    const projects = path.join(directory, "projects");
    for (const project of await safeEntries(projects)) {
      const projectDir = path.join(projects, project); sessions += (await safeEntries(path.join(projectDir, "sessions"))).length;
      for (const key of Object.keys(categories)) categories[key] = (categories[key] ?? 0) + await categorySize(projectDir, key);
    }
  } else {
    sessions = (await safeEntries(path.join(directory, "sessions"))).length;
    for (const key of Object.keys(categories)) categories[key] = await categorySize(directory, key);
  }
  return { label, directory, bytes, sessions, categories };
}

async function categorySize(directory: string, category: string): Promise<number> {
  if (category !== "other") return directorySize(path.join(directory, category));
  const known = new Set(["sessions", "workspaces", "git", "attachments", "scratch", "quarantine"]);
  let total = 0;
  for (const entry of await safeEntries(directory)) if (!known.has(entry)) total += await directorySize(path.join(directory, entry));
  return total;
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await safeEntries(directory)) {
    const item = path.join(directory, entry);
    const info = await lstat(item);
    if (info.isDirectory()) total += await directorySize(item);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

async function safeEntries(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch { return []; }
}

async function confirmInTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("Confirmation requires a terminal; pass --yes for non-interactive cleanup");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return ["y", "yes"].includes((await prompt.question(`${question} [y/N] `)).trim().toLowerCase()); }
  finally { prompt.close(); }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
