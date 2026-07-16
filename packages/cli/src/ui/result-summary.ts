import type { DevelopmentRunResult, HarnessEvent, SessionRecord } from "@runharness/shared";

export interface TuiResultSummary {
  outcome: "completed" | "failed" | "stopped";
  iterations: number;
  implementation: string;
  checks: { passed: number; total: number; items: Array<{ status: string; summary: string }> };
  review: { decision: "accept" | "request_changes" | "unavailable" | "not_run"; reviewer?: string; text: string };
  changedFiles: string[];
  placement: "in_place" | "isolated";
  delivery: string;
  nextActions: Array<{ command: string; description: string }>;
}

/** 仅根据 Runtime 已持久化的 Run 数据生成结果视图，不发起模型调用、不消耗 token。 */
export function buildTuiResultSummary(session: SessionRecord, result: DevelopmentRunResult, events: HarnessEvent[]): TuiResultSummary {
  const configuredEvidence = result.evidence.filter((item) => item.source === "configured_acceptance");
  const evidence = configuredEvidence.length ? configuredEvidence : result.evidence;
  const review = result.reviews.at(-1);
  const generatorHandoff = [...events].reverse().find((event) => event.actor === "generator" && event.type === "handoff");
  const payload = generatorHandoff?.payload as Record<string, unknown> | undefined;
  const implementation = readableText(payload?.summary ?? payload?.text ?? payload?.result)
    || (result.changes.changedFiles.length ? `Changed ${result.changes.changedFiles.length} file${result.changes.changedFiles.length === 1 ? "" : "s"}.` : "No implementation summary was recorded.");
  const outcome = session.status === "completed" || session.status === "stopped" ? session.status : "failed";
  const nextActions: TuiResultSummary["nextActions"] = [];
  if (result.placement === "isolated" && result.delivery.status === "pending") {
    nextActions.push({ command: "/apply", description: "deliver these changes to the source project" });
    nextActions.push({ command: "/discard", description: "remove the isolated result" });
  }
  if (outcome !== "completed" || review?.decision === "request_changes" || review?.decision === "unavailable") {
    nextActions.push({ command: "/continue MESSAGE", description: "add guidance and run the same Session again" });
  } else {
    nextActions.push({ command: "/continue MESSAGE", description: "refine this result in the same Session" });
  }
  nextActions.push({ command: "/new", description: "leave this Session and start unrelated work" });

  return {
    outcome,
    iterations: result.iterations,
    implementation,
    checks: {
      passed: evidence.filter((item) => item.status === "passed").length,
      total: evidence.length,
      items: evidence.map((item) => ({ status: item.status, summary: item.summary })),
    },
    review: review
      ? { decision: review.decision, reviewer: review.reviewer, text: review.text }
      : { decision: "not_run", text: result.reviewStatus === "pending" ? "Review is still pending." : "No Review result was recorded." },
    changedFiles: result.changes.changedFiles,
    placement: result.placement,
    delivery: result.placement === "in_place"
      ? "Changes are already live in the source project."
      : result.delivery.status === "pending"
        ? "Changes remain in the isolated workspace until Apply or Discard."
        : `The isolated result was ${result.delivery.status}.`,
    nextActions,
  };
}

function readableText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}
