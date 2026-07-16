import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeRegistration } from "@runharness/shared";
import { defaultRunHarnessHome } from "./project-storage.js";

const STALE_AFTER_MS = 15_000;

/** 注册一个本地 Runtime，并在存活期间持续维护其发现记录。 */
export async function registerRuntime(projectDir: string, url: string, home = defaultRunHarnessHome()): Promise<{ registration: RuntimeRegistration; stop: () => Promise<void> }> {
  assertLocalUrl(url);
  const directory = registryDirectory(home);
  await mkdir(directory, { recursive: true });
  const id = createHash("sha256").update(`${projectDir}\0${process.pid}`).digest("hex").slice(0, 16);
  const startedAt = new Date().toISOString();
  const file = path.join(directory, `${id}.json`);
  const write = async () => {
    const registration: RuntimeRegistration = {
      id,
      projectDir,
      projectName: path.basename(projectDir),
      url,
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    };
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(registration, null, 2));
    await rename(temporary, file);
    return registration;
  };
  const registration = await write();
  const timer = setInterval(() => void write().catch(() => undefined), 5_000);
  timer.unref();
  return {
    registration,
    stop: async () => { clearInterval(timer); await rm(file, { force: true }); },
  };
}

/** 返回仍存活的本机 Runtime，同时清理已退出进程留下的陈旧记录。 */
export async function listRuntimes(home = defaultRunHarnessHome()): Promise<RuntimeRegistration[]> {
  const directory = registryDirectory(home);
  await mkdir(directory, { recursive: true });
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  const live: RuntimeRegistration[] = [];
  for (const file of files) {
    const absolute = path.join(directory, file);
    try {
      const item = JSON.parse(await readFile(absolute, "utf8")) as RuntimeRegistration;
      assertRegistration(item);
      const stale = Date.now() - Date.parse(item.heartbeatAt) > STALE_AFTER_MS;
      if (stale || !isProcessAlive(item.pid)) { await rm(absolute, { force: true }); continue; }
      live.push(item);
    } catch {
      await rm(absolute, { force: true });
    }
  }
  return live.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.startedAt.localeCompare(b.startedAt));
}

/** 查找当前已经持有指定项目的存活 Runtime。 */
export async function findProjectRuntime(projectDir: string, home = defaultRunHarnessHome()): Promise<RuntimeRegistration | undefined> {
  const project = path.resolve(projectDir);
  return (await listRuntimes(home)).find((runtime) => path.resolve(runtime.projectDir) === project);
}

function registryDirectory(home: string): string {
  return path.join(home, "runtimes");
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function assertLocalUrl(url: string): void {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) throw new Error("Runtime registry only accepts localhost URLs");
}

function assertRegistration(item: RuntimeRegistration): void {
  if (!item.id || !path.isAbsolute(item.projectDir) || !Number.isInteger(item.pid)) throw new Error("Invalid Runtime registration");
  assertLocalUrl(item.url);
  if (!Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.heartbeatAt))) throw new Error("Invalid Runtime timestamps");
}
