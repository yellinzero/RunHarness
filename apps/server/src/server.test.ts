import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exampleModelConfig, runProcess } from "@runharness/providers";
import { buildServer } from "./index.js";

const root = path.resolve(".tmp/tests", `server-${Date.now()}`);
const dashboardDir = path.join(root, "dashboard");
await mkdir(path.join(dashboardDir, "assets"), { recursive: true });
await writeFile(path.join(dashboardDir, "index.html"), "<!doctype html><title>RunHarness Dashboard</title><div id=\"root\"></div>");
const testModelConfig = structuredClone(exampleModelConfig);
testModelConfig.mcpServers!.playwright!.enabled = false;
await writeFile(path.join(root, "config.json"), JSON.stringify(testModelConfig));
const receivedIterations: number[] = [];
const app = await buildServer({
  dataDir: root,
  dashboardDir,
  projectDir: root,
  sessionRunner: async (request, sessionId, sessions, signal) => {
    receivedIterations.push(request.maxIterations ?? -1);
    await sessions.setStatus(sessionId, "running");
    await sessions.emit(sessionId, "system", "session_started", { goal: request.goal });
    if (request.goal === "Fail before workspace") {
      const run = await sessions.getRun(sessionId);
      await sessions.emit(sessionId, "system", "run_started", { runId: run.id, placement: "isolated", source: root, goal: request.goal, userInput: request.goal });
      await sessions.emit(sessionId, "system", "run_failed", { message: "workspace preparation failed" });
      await sessions.setStatus(sessionId, "failed");
      return;
    }
    if (request.goal === "Wait until stopped") {
      await new Promise<void>((_resolve, reject) => {
        const stop = async () => {
          const run = await sessions.getRun(sessionId);
          await sessions.saveResult(sessionId, { sessionId, runId: run.id, workspace: root, placement: "in_place", iterations: 0, completed: false, baselineCommit: "baseline", baselineRepository: path.join(root, ".git"), sourceRoot: root, changes: { workspace: root, status: "", diff: "", changedFiles: [], deletedFiles: [] }, evidence: [], reviews: [], delivery: { status: "applied" } });
          await sessions.emit(sessionId, "system", "run_stopped", { message: "Stopped by user" }); await sessions.setStatus(sessionId, "stopped");
          const error = new Error("stopped"); error.name = "AbortError"; reject(error);
        };
        if (signal.aborted) void stop(); else signal.addEventListener("abort", () => void stop(), { once: true });
      });
    }
    if (request.goal.startsWith("Deliver isolated")) {
      const workspace = path.join(root, "workspaces", sessionId, "primary");
      await mkdir(workspace, { recursive: true });
      await runProcess("git", ["init"], { cwd: workspace });
      await runProcess("git", ["-c", "user.name=RunHarness", "-c", "user.email=test@runharness.local", "commit", "--allow-empty", "-m", "baseline"], { cwd: workspace });
      const baselineCommit = (await runProcess("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
      await writeFile(path.join(workspace, `${sessionId}.txt`), "isolated result\n");
      const run = await sessions.getRun(sessionId);
      await sessions.saveResult(sessionId, {
        sessionId, runId: run.id, workspace, placement: "isolated", iterations: 1, completed: true,
        baselineCommit, baselineRepository: path.join(workspace, ".git"), sourceRoot: root,
        changes: { workspace, status: `A  ${sessionId}.txt`, diff: "", changedFiles: [`${sessionId}.txt`], deletedFiles: [] },
        evidence: [], reviews: [], delivery: { status: "pending" },
      });
    }
    if (request.goal === "Review service unavailable") {
      const run = await sessions.getRun(sessionId);
      await sessions.saveResult(sessionId, {
        sessionId, runId: run.id, workspace: root, placement: "in_place", iterations: 1, completed: false, reviewStatus: "pending",
        baselineCommit: "baseline", baselineRepository: path.join(root, ".git"), sourceRoot: root,
        changes: { workspace: root, status: "M app.ts", diff: "", changedFiles: ["app.ts"], deletedFiles: [] },
        evidence: [], reviews: [{ reviewer: "grok", status: "control_missing", decision: "unavailable", text: "The Agent did not report a review decision." }], delivery: { status: "applied" },
      });
      await sessions.emit(sessionId, "evaluator", "verdict", { iteration: 1, reviewer: "grok", status: "control_missing", decision: "unavailable", text: "The Agent did not report a review decision." });
      await sessions.emit(sessionId, "system", "run_failed", { completed: false, reviewStatus: "pending", failure: { category: "review", recoverable: true } });
      await sessions.setStatus(sessionId, "failed");
      return;
    }
    await sessions.emit(sessionId, "planner", "handoff", { plan: "Inspect and change one file" });
    await sessions.emit(sessionId, "planner", "plan_proposed", { acceptance: ["file changed"] });
    await sessions.emit(sessionId, "generator", "handoff", { summary: "Changed one file" });
    await sessions.emit(sessionId, "evaluator", "verdict", { iteration: 1, reviewer: "test:evaluator", decision: "accept", text: "Verified" });
    await sessions.emit(sessionId, "system", "run_completed", { completed: true });
    await sessions.setStatus(sessionId, "completed");
  },
});
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

describe("server API", () => {
  it("versions editable system prompts through the Dashboard API", async () => {
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const before = snapshot.json().prompts.find((slot: { key: string }) => slot.key === "common_kernel") as { currentVersion: number; editable: boolean; applications: Array<{ node: string; channel: string }> };
    expect(before.editable).toBe(true);
    expect(before.applications).toContainEqual({ node: "planner_plan", channel: "system_prompt" });
    const content = "Keep evidence concrete while preserving Runtime-owned safety boundaries.";
    const saved = await app.inject({ method: "PATCH", url: "/api/prompts/common_kernel", payload: { content } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ currentVersion: before.currentVersion + 1, editable: true });
    const persisted = JSON.parse(await readFile(path.join(root, "prompts.json"), "utf8")) as Array<{ key: string; currentVersion: number; history: Array<{ content: string }> }>;
    expect(persisted.find((slot) => slot.key === "common_kernel")).toMatchObject({ currentVersion: before.currentVersion + 1, history: expect.arrayContaining([expect.objectContaining({ content })]) });
  });

  it("exposes the provider-owned built-in permission catalog", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runtime/permission-catalog" });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries.map((entry: { id: string }) => entry.id)).toEqual(["destructive_changes", "credential_access", "external_network", "mcp_side_effects", "reversible_development"]);
  });

  it("starts a session asynchronously and exposes its terminal state", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Build asynchronously" } });
    expect(started.statusCode).toBe(202);
    const { sessionId } = started.json() as { sessionId: string };
    let status = "running";
    for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      status = detail.json().session.status as string;
    }
    expect(status).toBe("completed");
    expect(await readFile(path.join(root, "progress", `${sessionId}.md`), "utf8")).toContain("Latest status: completed");
  });

  it("exposes completed sessions in the dashboard snapshot", async () => {
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapshot.statusCode).toBe(200); expect(snapshot.json().events.length).toBeGreaterThan(5);
  });

  it("exposes project-owned MCP server status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/mcp" });
    expect(response.statusCode).toBe(200);
    expect(response.json().servers).toContainEqual(expect.objectContaining({ name: "playwright", enabled: false, available: false }));
    const current = (await app.inject({ method: "GET", url: "/api/config" })).json().config;
    const invalid = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { ...current, mcpServers: { "bad name": { command: "node" } } } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("may only contain");
    const invalidEnv = structuredClone(current);
    invalidEnv.agents[0].backend.env = { SHARED: 1 };
    const rejectedEnv = await app.inject({ method: "PUT", url: "/api/config", payload: { config: invalidEnv } });
    expect(rejectedEnv.statusCode).toBe(400);
    expect(rejectedEnv.json().error).toContain("env must contain string values");
  });

  it("exposes execution ownership without starting disabled tools", async () => {
    const response = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runtimes).toEqual([expect.objectContaining({ id: "local-command", owner: "runharness", placement: "host", controlled: true, limitations: [expect.stringContaining("not OS containment")] })]);
    expect(body.acceptance).toEqual([]);
    expect(body.agents.every((agent: { capabilities?: unknown }) => agent.capabilities)).toBe(true);
  });

  it("serves the dashboard for deep run routes and keeps API 404s structured", async () => {
    const page = await app.inject({ method: "GET", url: "/runs/session-1/evaluation" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("RunHarness Dashboard");
    const missingApi = await app.inject({ method: "GET", url: "/api/not-real" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "Not found" });
  });

  it("records a human decision for a real review event", async () => {
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const verdict = snapshot.json().events.find((event: { type: string }) => event.type === "verdict") as { id: string } | undefined;
    expect(verdict?.id).toBeTruthy();
    const missingReason = await app.inject({ method: "POST", url: "/api/reviews", payload: { eventId: verdict?.id, decision: "accept", reason: " " } });
    expect(missingReason.statusCode).toBe(400);
    const reviewed = await app.inject({ method: "POST", url: "/api/reviews", payload: { eventId: verdict?.id, decision: "accept", reason: "已检查" } });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().eventId).toBe(verdict?.id);
    expect(reviewed.json().reason).toBe("已检查");
  });

  it("lets a human resolve an unavailable evaluator", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Review service unavailable" } });
    const sessionId = started.json().sessionId as string;
    let detail;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      if (detail.json().session.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const verdict = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/events` })).json().find((event: { type: string }) => event.type === "verdict") as { id: string };
    const reviewed = await app.inject({ method: "POST", url: "/api/reviews", payload: { eventId: verdict.id, decision: "accept", reason: "Inspected the changed files and process evidence" } });
    expect(reviewed.statusCode).toBe(200);
    const resolved = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json();
    expect(resolved.result).toMatchObject({ completed: true, reviewStatus: "completed" });
    expect(resolved.session.status).toBe("completed");
  });

  it("makes isolated delivery mutually exclusive and idempotent", async () => {
    const start = async (goal: string) => {
      const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal } });
      const sessionId = started.json().sessionId as string;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
        if (detail.json().session.status !== "running") return sessionId;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("session did not finish");
    };

    const appliedId = await start("Deliver isolated apply");
    const applied = await app.inject({ method: "POST", url: `/api/sessions/${appliedId}/result`, payload: { action: "apply" } });
    expect(applied.statusCode).toBe(200);
    expect(await readFile(path.join(root, `${appliedId}.txt`), "utf8")).toBe("isolated result\n");
    expect((await app.inject({ method: "POST", url: `/api/sessions/${appliedId}/result`, payload: { action: "apply" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${appliedId}/result`, payload: { action: "discard" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${appliedId}` })).json().result.delivery.status).toBe("applied");
    const linked = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Deliver isolated linked refinement", parentSessionId: appliedId, placement: "isolated" } });
    expect(linked.statusCode).toBe(202);
    expect(linked.json().sessionId).not.toBe(appliedId);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${linked.json().sessionId}` })).json().session.parentSessionId).toBe(appliedId);

    const discardedId = await start("Deliver isolated discard");
    expect((await app.inject({ method: "POST", url: `/api/sessions/${discardedId}/result`, payload: { action: "discard" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${discardedId}/result`, payload: { action: "discard" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${discardedId}/result`, payload: { action: "apply" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${discardedId}` })).json().result.delivery.status).toBe("discarded");
  });

  it("stores a project iteration default and accepts a one-session override", async () => {
    const current = (await app.inject({ method: "GET", url: "/api/runtime" })).json();
    const saved = await app.inject({ method: "PUT", url: "/api/runtime", payload: { ...current, maxIterations: 6 } });
    expect(saved.statusCode).toBe(200);
    const savedSettings = saved.json() as Record<string, unknown>;
    await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Use project iterations" } });
    await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Override iterations", maxIterations: 2 } });
    expect(receivedIterations.slice(-2)).toEqual([6, 2]);
    expect((await app.inject({ method: "PUT", url: "/api/runtime", payload: { ...savedSettings, maxIterations: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Invalid iterations", maxIterations: 21 } })).statusCode).toBe(400);
  });

  it("interrupts an active session and records a stopped terminal state", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Wait until stopped" } });
    const sessionId = started.json().sessionId as string;
    const stopped = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/stop` });
    expect(stopped.statusCode).toBe(202);
    let status = "running";
    for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json().session.status as string;
    }
    expect(status).toBe("stopped");
    const repeated = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/stop` });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ sessionId, status: "stopped" });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/events` })).json())
      .toContainEqual(expect.objectContaining({ type: "run_stopped" }));
  });

  it("atomically steers an active Run into a new Run in the same Session", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Wait until stopped" } });
    const sessionId = started.json().sessionId as string;
    const steered = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/steer`, payload: { requestId: "steer_test", message: "Finish after steering" } });
    expect(steered.statusCode).toBe(202);
    expect(steered.json()).toMatchObject({ sessionId, status: "running" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json();
      if (detail.session.status !== "running") { expect(detail.session.runCount).toBe(2); break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/events` })).json()).toContainEqual(expect.objectContaining({ type: "steer_requested", payload: expect.objectContaining({ requestId: "steer_test" }) }));
  });

  it("creates later Runs under the same stable Session ID", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Deliver isolated first" } });
    const { sessionId, runId: firstRunId } = started.json() as { sessionId: string; runId: string };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      if (detail.json().session.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const next = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/runs`, payload: { message: "Continue in the same conversation" } });
    expect(next.statusCode).toBe(202);
    expect(next.json().sessionId).toBe(sessionId);
    expect(next.json().runId).not.toBe(firstRunId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      if (detail.json().session.status !== "running") {
        expect(detail.json().session.runCount).toBe(2);
        expect(detail.json().runs).toHaveLength(2);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("second Run did not finish");
  });

  it("allows a corrective Run when workspace preparation failed before a result existed", async () => {
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Fail before workspace", placement: "isolated" } });
    const { sessionId, runId: firstRunId } = started.json() as { sessionId: string; runId: string };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      if (detail.json().session.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const next = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/runs`, payload: { message: "Retry after correcting Runtime storage" } });
    expect(next.statusCode).toBe(202);
    expect(next.json().sessionId).toBe(sessionId);
    expect(next.json().runId).not.toBe(firstRunId);
  });

  it("deletes a terminal Session and all local Session-owned assets", async () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
    const uploaded = await app.inject({ method: "POST", url: "/api/attachments", payload: { name: "delete.png", data: data.toString("base64") } });
    const attachmentId = uploaded.json().attachment.id as string;
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Deliver isolated delete", attachmentIds: [attachmentId] } });
    const sessionId = started.json().sessionId as string;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
      if (detail.json().session.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).statusCode).toBe(404);
    await expect(readFile(path.join(root, "attachments", "sessions", sessionId, `${attachmentId}.image`))).rejects.toThrow();
    await expect(readFile(path.join(root, "workspaces", sessionId, "primary", `${sessionId}.txt`))).rejects.toThrow();
    const audit = await readFile(path.join(root, "deletions.jsonl"), "utf8");
    expect(audit).toContain(sessionId);
    expect(audit).not.toContain("Deliver isolated delete");
  });

  it("uploads validated image bytes and accepts only managed IDs for sessions", async () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const uploaded = await app.inject({ method: "POST", url: "/api/attachments", payload: { name: "shot.png", data: data.toString("base64") } });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json().attachment as { id: string };
    const started = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Use the screenshot", attachmentIds: [attachment.id] } });
    expect(started.statusCode).toBe(202);
    const sessionId = started.json().sessionId as string;
    expect(await readFile(path.join(root, "attachments", "sessions", sessionId, `${attachment.id}.image`))).toEqual(data);
    let status = "running";
    for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json().session.status as string;
    }
    expect(status).toBe("completed");
    const events = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/events` });
    expect(events.body).not.toContain(data.toString("base64"));

    const rejected = await app.inject({ method: "POST", url: "/api/sessions", payload: { goal: "Unsafe path", attachmentIds: ["../../outside"] } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("outside.png");
    expect((await app.inject({ method: "GET", url: "/api/snapshot" })).json().sessions)
      .not.toContainEqual(expect.objectContaining({ goal: "Unsafe path" }));
  });

  it("releases Session-owned storage across a repeated lifecycle soak", async () => {
    const soakRoot = path.resolve(".tmp/tests", `server-soak-${Date.now()}`); await mkdir(soakRoot, { recursive: true });
    const soak = await buildServer({
      dataDir: soakRoot,
      dashboardDir,
      projectDir: root,
      sessionRunner: async (_request, sessionId, sessions) => {
        await sessions.setStatus(sessionId, "running");
        await sessions.emit(sessionId, "system", "run_completed", { completed: true });
        await sessions.setStatus(sessionId, "completed");
      },
    });
    try {
      const started = await Promise.all(Array.from({ length: 30 }, (_, index) => soak.inject({ method: "POST", url: "/api/sessions", payload: { goal: `soak ${index}` } })));
      const sessionIds = started.map((response) => response.json().sessionId as string);
      for (const sessionId of sessionIds) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const detail = await soak.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
          if (detail.json().session.status === "completed") break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect((await soak.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` })).statusCode).toBe(204);
      }
      expect((await soak.inject({ method: "GET", url: "/api/snapshot" })).json().sessions).toEqual([]);
      expect(await readdir(path.join(soakRoot, "sessions"))).toEqual([]);
      expect(await readdir(path.join(soakRoot, "workspaces"))).toEqual([]);
      expect(await readdir(path.join(soakRoot, "workspace-records"))).toEqual([]);
      expect(await readdir(path.join(soakRoot, "scratch")).catch(() => [])).toEqual([]);
    } finally {
      await soak.close();
      await rm(soakRoot, { recursive: true, force: true });
    }
  });
});
