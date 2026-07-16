import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangeSet, DevelopmentReview, EvidenceRecord, HarnessEvent, WorkspacePlacement } from "@runharness/shared";

const MAX_SECTION_CHARS = 12_000;

export interface RunContextInput {
  sessionId: string;
  goal: string;
  userInput?: string;
  previousRunId?: string;
  contextRoot: string;
  workspace: string;
  placement: WorkspacePlacement;
  plan?: string;
  changes?: ChangeSet;
  evidence?: EvidenceRecord[];
  reviews?: DevelopmentReview[];
  priorEvidence?: string;
  nextStep?: string;
}

/** 将有大小边界的恢复上下文写入 Runtime 数据区，绝不污染目标仓库。 */
export async function writeRunContext(input: RunContextInput): Promise<string> {
  const directory = path.resolve(input.contextRoot);
  const file = path.join(directory, `${input.sessionId}.md`);
  await mkdir(directory, { recursive: true });
  const packageManager = await detectPackageManager(input.workspace);
  const blockingEvidence = input.evidence?.filter((item) => item.blocksCompletion).map((item) => ({
    runtime: item.runtimeId,
    placement: item.placement,
    capability: item.capability,
    status: item.status,
    category: item.failureCategory,
    summary: bounded(item.summary, 4_000),
  })) ?? [];
  const content = `# RunHarness run context

- Session: ${input.sessionId}
- Previous Run: ${input.previousRunId ?? "none"}
- Workspace: ${input.workspace}
- Workspace placement: ${input.placement}
- Package manager: ${packageManager}

## Original goal

${bounded(input.goal)}

## Latest user input

${bounded(input.userInput ?? input.goal)}

## Earlier run evidence

${bounded(input.priorEvidence ?? "No earlier run.")}

## Plan

${bounded(input.plan ?? "Not planned yet.")}

## Current changes

${bounded(JSON.stringify({ status: input.changes?.status ?? "", changedFiles: input.changes?.changedFiles ?? [], deletedFiles: input.changes?.deletedFiles ?? [] }, null, 2))}

## Blocking acceptance evidence

${bounded(JSON.stringify(blockingEvidence, null, 2))}

## Review evidence

${bounded(JSON.stringify(input.reviews ?? [], null, 2))}

## Next step

${bounded(input.nextStep ?? "Inspect the repository and continue the requested work.")}
`;
  await writeFile(file, content);
  return file;
}

export function priorRunEvidence(events: HarnessEvent[], result?: { evidence?: EvidenceRecord[]; reviews?: DevelopmentReview[] }): string {
  const terminal = events.filter((event) => ["run_failed", "run_stopped"].includes(event.type)).at(-1);
  const userInputs = events.filter((event) => event.type === "run_started").flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.userInput === "string" ? [payload.userInput] : [];
  });
  const steeringAdditions = events.filter((event) => event.type === "steer_requested").flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.message === "string" ? [payload.message] : [];
  });
  const handoffs = events.filter((event) => event.type === "handoff").slice(-4).map((event) => ({ actor: event.actor, payload: event.payload }));
  return JSON.stringify({
    userInputs,
    steeringAdditions,
    terminal: terminal?.payload,
    blockingEvidence: result?.evidence?.filter((item) => item.blocksCompletion) ?? [],
    reviews: result?.reviews ?? [],
    recentHandoffs: handoffs,
  }, null, 2);
}

export async function detectPackageManager(workspace: string): Promise<"pnpm" | "yarn" | "npm" | "unknown"> {
  try {
    const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as { packageManager?: unknown };
    if (typeof manifest.packageManager === "string") {
      if (manifest.packageManager.startsWith("pnpm@")) return "pnpm";
      if (manifest.packageManager.startsWith("yarn@")) return "yarn";
      if (manifest.packageManager.startsWith("npm@")) return "npm";
    }
  } catch { /* package.json 不可用时回退检查锁文件。 */ }
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]] as const) {
    try { await readFile(path.join(workspace, file)); return manager; } catch { /* 当前锁文件不存在时检查下一种。 */ }
  }
  return "unknown";
}

export async function runContextSummary(file: string, maxChars: number): Promise<string> {
  return bounded(await readFile(file, "utf8"), maxChars);
}

export function runContextInstruction(file: string): string {
  return `First read the RunHarness context file at ${file}. It contains the bounded recovery evidence and next step. Inspect the repository and command output directly instead of asking for them to be pasted into the prompt.`;
}

function bounded(value: string, limit = MAX_SECTION_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated; inspect the repository or command output directly …` : value;
}
