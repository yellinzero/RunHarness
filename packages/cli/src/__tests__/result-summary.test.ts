import { describe, expect, it } from "vitest";
import type { DevelopmentRunResult, HarnessEvent, SessionRecord } from "@runharness/shared";
import { buildTuiResultSummary } from "../ui/result-summary.js";

const session: SessionRecord = {
  id: "session", goal: "Improve results", status: "completed", createdAt: "", updatedAt: "", eventCount: 1,
  runCount: 1, latestRunId: "run", workspacePlacement: "in_place", workspaceAccess: "read_write", deliveryStatus: "live",
};

function result(overrides: Partial<DevelopmentRunResult> = {}): DevelopmentRunResult {
  return {
    sessionId: "session", runId: "run", workspace: "/tmp/project", placement: "in_place", iterations: 1, completed: true,
    baselineCommit: "baseline", baselineRepository: "/tmp/runtime.git", sourceRoot: "/tmp/project",
    changes: { workspace: "/tmp/project", status: "", diff: "", changedFiles: ["src/result.ts"], deletedFiles: [] },
    evidence: [{ id: "check", source: "configured_acceptance", owner: "runharness", runtimeId: "local-command", placement: "host", capability: "command", requirement: "required", status: "passed", blocksCompletion: true, summary: "pnpm test passed", startedAt: "", artifacts: [] }],
    reviews: [{ reviewer: "grok", decision: "accept", text: "Accepted" }], delivery: { status: "applied" }, ...overrides,
  };
}

describe("TUI result summary", () => {
  it("derives the implementation, checks, Review, files, and in-place actions without a model call", () => {
    const events: HarnessEvent[] = [{ id: "handoff", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "generator", type: "handoff", payload: { summary: "Implemented the terminal result page." } }];
    const summary = buildTuiResultSummary(session, result(), events);
    expect(summary).toMatchObject({ outcome: "completed", iterations: 1, implementation: "Implemented the terminal result page.", checks: { passed: 1, total: 1 }, review: { decision: "accept", reviewer: "grok" }, changedFiles: ["src/result.ts"], placement: "in_place" });
    expect(summary.delivery).toContain("already live");
    expect(summary.nextActions.map((item) => item.command)).toEqual(["/continue MESSAGE", "/new"]);
  });

  it("offers Apply and Discard only for a pending isolated result", () => {
    const summary = buildTuiResultSummary({ ...session, workspacePlacement: "isolated", deliveryStatus: "pending" }, result({ placement: "isolated", delivery: { status: "pending" } }), []);
    expect(summary.nextActions.map((item) => item.command)).toEqual(["/apply", "/discard", "/continue MESSAGE", "/new"]);
  });

  it("makes an unavailable Review actionable without inventing Apply for in-place work", () => {
    const failed = buildTuiResultSummary({ ...session, status: "failed" }, result({ completed: false, reviews: [{ reviewer: "grok", decision: "unavailable", text: "Provider connection failed", status: "control_missing" }] }), []);
    expect(failed.outcome).toBe("failed");
    expect(failed.review.text).toBe("Provider connection failed");
    expect(failed.nextActions.map((item) => item.command)).toContain("/continue MESSAGE");
    expect(failed.nextActions.map((item) => item.command)).not.toContain("/apply");
  });
});
