import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPrintEvent, printResult } from "../commands/print.js";

afterEach(() => vi.restoreAllMocks());

describe("print mode event formatting", () => {
  it("uses the review control decision instead of the deleted pass field", () => {
    const event = { id: "review", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "evaluator" as const, type: "verdict" as const, payload: { decision: "accept", text: "## Accepted" } };
    expect(formatPrintEvent(event)).toBe("[review] PASS ## Accepted");
  });

  it("prints the same terminal result facts as the interactive TUI", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    const session = { id: "session", goal: "result", status: "completed" as const, createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, latestRunId: "run", workspacePlacement: "in_place" as const, workspaceAccess: "read_write" as const, deliveryStatus: "live" as const };
    const result = { sessionId: "session", runId: "run", workspace: "/tmp/project", placement: "in_place" as const, iterations: 2, completed: true, baselineCommit: "baseline", baselineRepository: "/tmp/runtime.git", sourceRoot: "/tmp/project", changes: { workspace: "/tmp/project", status: "", diff: "", changedFiles: ["src/a.ts"], deletedFiles: [] }, evidence: [], reviews: [{ reviewer: "grok", decision: "accept" as const, text: "Accepted" }], delivery: { status: "applied" as const } };
    printResult(session, result);
    expect(output).toContain("status completed");
    expect(output).toContain("iterations 2");
    expect(output).toContain("review accept · grok");
    expect(output).toContain("changed 1");
    expect(output).toContain("  src/a.ts");
  });
});
