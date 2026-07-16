import type { DevelopmentRunResult, HarnessEvent, SessionRecord, StartSessionResponse, WorkspacePlacement } from "@runharness/shared";
import { resolveProjectRoot } from "@runharness/development";
import { buildServer } from "@runharness/server";
import { installedDashboardDir } from "../runtime/installation.js";
import { buildTuiResultSummary } from "../ui/result-summary.js";

/** 不渲染交互式 TUI，但仍通过正常 Runtime 路径执行一个 Session。 */
export async function runPrintMode(goal: string, placement: WorkspacePlacement | undefined, project = process.cwd(), maxIterations?: number): Promise<boolean> {
  const projectDir = await resolveProjectRoot(project);
  const server = await buildServer({ projectDir, dashboardDir: installedDashboardDir() });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine local Runtime address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, ...(placement ? { placement } : {}), source: projectDir, ...(maxIterations ? { maxIterations } : {}) }),
    });
    const started = await response.json() as StartSessionResponse & { error?: string };
    if (!response.ok) throw new Error(started.error ?? `HTTP ${response.status}`);
    console.log(`session ${started.sessionId}`);
    let offset = 0;
    const allEvents: HarnessEvent[] = [];
    while (true) {
      const [detailResponse, eventsResponse] = await Promise.all([
        fetch(`${baseUrl}/api/sessions/${started.sessionId}`),
        fetch(`${baseUrl}/api/sessions/${started.sessionId}/events?offset=${offset}&limit=200`),
      ]);
      if (!detailResponse.ok || !eventsResponse.ok) throw new Error("Could not read session progress");
      const detail = await detailResponse.json() as { session: SessionRecord; result?: DevelopmentRunResult };
      const events = await eventsResponse.json() as HarnessEvent[];
      allEvents.push(...events);
      for (const event of events) console.log(formatPrintEvent(event));
      offset += events.length;
      if (detail.session.status !== "running" && detail.session.status !== "idle") {
        printResult(detail.session, detail.result, allEvents);
        return detail.session.status === "completed";
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    await server.close();
  }
}

export function formatPrintEvent(event: HarnessEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const identity = [payload.agentId ?? payload.backend, payload.model].filter(Boolean).join(" · ");
  const iter = typeof payload.iteration === "number" ? ` r${payload.iteration}` : "";
  if (event.type === "iteration_started") return `[iteration] ${payload.iteration}/${payload.maxIterations ?? "?"}`;
  if (event.type === "agent_started") return `[${event.actor}${iter}] started${identity ? ` · ${identity}` : ""}`;
  if (event.type === "agent_completed") return `[${event.actor}${iter}] done${identity ? ` · ${identity}` : ""}`;
  if (event.type === "message" && payload.action !== "stop_requested") {
    const phase = payload.phase === "thinking" ? "thinking" : payload.phase === "status" ? "status" : "draft";
    return `[${event.actor}${iter}] ${phase} · ${readable(String(payload.summary ?? payload.text ?? "")).slice(0, 160)}`;
  }
  if (event.type === "tool_call") return `[${event.actor}${iter}] tool ${payload.tool ?? payload.name ?? "tool"} · ${String(payload.summary ?? payload.command ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
  if (event.type === "handoff") return `[${event.actor}${iter}] ${readable(String(payload.summary ?? payload.plan ?? "handoff")).split("\n")[0]!.slice(0, 180)}`;
  if (event.type === "tool_result" && payload.evidence && typeof payload.evidence === "object" && (payload.evidence as Record<string, unknown>).source === "configured_acceptance") {
    const evidence = payload.evidence as Record<string, unknown>;
    return `[acceptance] ${String(evidence.status).toUpperCase()} ${evidence.capability} · ${evidence.runtimeId ?? evidence.placement} (${evidence.durationMs}ms)`;
  }
  if (event.type === "verdict") {
    const decision = String(payload.decision ?? "unavailable");
    const state = decision === "accept" ? "PASS" : decision === "request_changes" ? "FAIL" : "PENDING";
    return `[review] ${state} ${readable(String(payload.text ?? payload.summary ?? "")).slice(0, 180)}`;
  }
  if (event.type === "run_failed") return `[failed] ${readable(String(payload.message ?? "Run failed"))}`;
  return `[${event.actor}] ${event.type}`;
}

function readable(value: string): string {
  const raw = value.trim();
  if (!raw.startsWith("{") || !raw.includes('"type"')) return raw;
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    try {
      const record = JSON.parse(line) as { type?: string; data?: string; result?: string; item?: { type?: string; text?: string } };
      if ((record.type === "text" || record.type === "thought") && typeof record.data === "string") parts.push(record.data);
      if (record.type === "result" && typeof record.result === "string") return record.result;
      if (record.item?.type === "agent_message" && typeof record.item.text === "string") return record.item.text;
    } catch { /* 当前事件不含结果时继续向前查找。 */ }
  }
  return parts.join("").replace(/\s+/g, " ").trim() || "Agent produced no readable final text.";
}

export function printResult(session: SessionRecord, result?: DevelopmentRunResult, events: HarnessEvent[] = []): void {
  console.log(`status ${session.status}`);
  if (!result) return;
  const summary = buildTuiResultSummary(session, result, events);
  console.log(`iterations ${summary.iterations}`);
  console.log(`workspace ${result.workspace}`);
  console.log(`delivery ${summary.placement} · ${result.delivery.status}`);
  console.log(`checks ${summary.checks.total ? `${summary.checks.passed}/${summary.checks.total} passed` : "not configured"}`);
  console.log(`review ${summary.review.decision}${summary.review.reviewer ? ` · ${summary.review.reviewer}` : ""}`);
  console.log(`implementation ${summary.implementation.replace(/\s+/g, " ").trim()}`);
  console.log(`changed ${summary.changedFiles.length}`);
  for (const file of summary.changedFiles) console.log(`  ${file}`);
  console.log(`next ${summary.nextActions.map((item) => item.command).join(" · ")}`);
}
