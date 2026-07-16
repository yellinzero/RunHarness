import { spawn } from "node:child_process";

export interface ProcessResult { stdout: string; stderr: string; code: number | null; durationMs: number }

export function runProcess(command: string, args: string[], options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onStdoutLine?: (line: string) => void }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    const started = Date.now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = ""; let stderr = ""; let settled = false; let lineBuffer = ""; let aborted = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!options.onStdoutLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onStdoutLine(line);
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const terminate = () => {
      if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch { /* 进程已经退出。 */ } }
      else child.kill("SIGTERM");
    };
    const onAbort = () => { aborted = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(terminate, options.timeoutMs ?? 300_000);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); reject(error); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      if (lineBuffer.trim()) options.onStdoutLine?.(lineBuffer);
      // CLI Agent 和测试运行器可能在主进程退出后遗留 worker。
      // 独立进程组由本次调用创建，因此收尾时必须关闭全部后代进程。
      terminate();
      if (aborted) reject(abortError());
      else resolve({ stdout, stderr, code, durationMs: Date.now() - started });
    });
    child.stdin.end(options.input ?? "");
  });
}

export function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }

function abortError(): Error { const error = new Error("Run interrupted"); error.name = "AbortError"; return error; }

export async function commandExists(command: string): Promise<boolean> {
  try { return (await runProcess(command, ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 })).code === 0; } catch { return false; }
}
