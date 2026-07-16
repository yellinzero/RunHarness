import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionStore, PromptRegistry } from "@runharness/core";
import { AgentPool, evaluatePermission, runProcess } from "@runharness/providers";
import type { AgentCall, AgentResponse } from "@runharness/providers";
import type { ModelRoutingConfig } from "@runharness/shared";
import { DevelopmentHarness } from "../loop/harness.js";
import { ExecutionRuntimeRegistry, LocalCommandRuntime } from "../runtime/execution-runtime.js";
import { runAcceptance } from "../verification/acceptance.js";
import { applyDevelopmentResult, discardDevelopmentResult } from "../workspace/delivery.js";
import { collectChangeSet, prepareDevelopmentWorkspace, readWorkspaceRecord, reconcileManagedWorkspaces, resolveProjectRoot } from "../workspace/manager.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("development session loop", () => {
  it("runs configured acceptance through its explicit host Runtime", async () => {
    const root = path.join(os.tmpdir(), `runharness-acceptance-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const runtimes = new ExecutionRuntimeRegistry([new LocalCommandRuntime()]);
    const results = await runAcceptance([{ kind: "command", name: "smoke", runtime: "local-command", command: "node -e \"process.stdout.write('portable')\"", required: true }], runtimes, { workspace: root });
    expect(results.map((item) => [item.runtimeId, item.status, item.placement])).toEqual([["local-command", "passed", "host"]]);
    expect(JSON.stringify(results.at(-1)?.native)).toContain("portable");
    await runtimes.stop();
  }, 15_000);

  it("uses the launch directory as the root for a non-Git project", async () => {
    const root = path.join("/tmp", `runharness-non-git-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "notes.txt"), "plain directory\n");
    expect(await resolveProjectRoot(root)).toBe(root);
    const runtime = `${root}-runtime`; roots.push(runtime);
    const prepared = await prepareDevelopmentWorkspace({ source: root, placement: "isolated", sessionId: "non_git", workspaceRoot: path.join(runtime, "workspaces"), runtimeRoot: runtime });
    expect(await readFile(path.join(prepared.workspace, "notes.txt"), "utf8")).toBe("plain directory\n");
    expect(prepared.baseline.commit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("applies only changed files from an isolated result", async () => {
    const root = path.join(os.tmpdir(), `runharness-delivery-${Date.now()}`); roots.push(root); const project = path.join(root, "project"); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "changed.txt"), "old\n"); await writeFile(path.join(project, "deleted.txt"), "remove\n");
    const prepared = await prepareDevelopmentWorkspace({ source: project, placement: "isolated", sessionId: "test", workspaceRoot, runtimeRoot: runtime }); const workspace = prepared.workspace;
    await writeFile(path.join(workspace, "changed.txt"), "new\n"); await writeFile(path.join(workspace, "added.txt"), "added\n");
    await rm(path.join(workspace, "deleted.txt"));
    const changes = await collectChangeSet(workspace, prepared.baseline);

    const files = await applyDevelopmentResult({ sessionId: "test", runId: "run", workspace, placement: "isolated", iterations: 1, completed: true, baselineCommit: prepared.baseline.commit, baselineRepository: prepared.baseline.repository, sourceRoot: project, changes, evidence: [], reviews: [], delivery: { status: "pending" } }, project, workspaceRoot);

    expect(files).toEqual(["added.txt", "changed.txt", "deleted.txt"]);
    expect(await readFile(path.join(project, "changed.txt"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(project, "added.txt"), "utf8")).toBe("added\n");
    await expect(readFile(path.join(project, "deleted.txt"), "utf8")).rejects.toThrow();
  });

  it("does not delete a project file when an isolated source copy fails", async () => {
    const root = path.join(os.tmpdir(), `runharness-delivery-copy-${Date.now()}`); roots.push(root); const project = path.join(root, "project"); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "keep.txt"), "keep\n");
    const prepared = await prepareDevelopmentWorkspace({ source: project, placement: "isolated", sessionId: "test", workspaceRoot, runtimeRoot: runtime }); const workspace = prepared.workspace;
    await writeFile(path.join(workspace, "keep.txt"), "changed\n");
    const changes = await collectChangeSet(workspace, prepared.baseline);
    const result = { sessionId: "test", runId: "run", workspace, placement: "isolated" as const, iterations: 1, completed: true, baselineCommit: prepared.baseline.commit, baselineRepository: prepared.baseline.repository, sourceRoot: project, changes, evidence: [], reviews: [], delivery: { status: "pending" as const } };
    await rm(path.join(workspace, "keep.txt"));

    await expect(applyDevelopmentResult(result, project, workspaceRoot)).rejects.toThrow();
    expect(await readFile(path.join(project, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects isolated workspaces and result paths outside their managed roots", async () => {
    const root = path.resolve(".tmp/tests", `delivery-boundary-${Date.now()}`); roots.push(root);
    const project = path.join(root, "project"); const workspaceRoot = path.join(root, "workspaces"); const outside = path.join(root, "outside", "primary");
    await mkdir(project, { recursive: true }); await mkdir(outside, { recursive: true });
    const base = { sessionId: "session_test", runId: "run_test", workspace: outside, placement: "isolated" as const, iterations: 1, completed: true, baselineCommit: "baseline", baselineRepository: path.join(outside, ".git"), sourceRoot: project, evidence: [], reviews: [], delivery: { status: "pending" as const } };
    await expect(discardDevelopmentResult({ ...base, changes: { workspace: outside, status: "", diff: "", changedFiles: [], deletedFiles: [] } }, workspaceRoot)).rejects.toThrow("outside the managed Runtime workspace root");
    const managed = path.join(workspaceRoot, "run_test", "primary"); await mkdir(managed, { recursive: true });
    await expect(applyDevelopmentResult({ ...base, workspace: managed, changes: { workspace: managed, status: "", diff: "", changedFiles: ["../outside.txt"], deletedFiles: [] } }, project, workspaceRoot)).rejects.toThrow("escapes the project");
    const externalTarget = path.join(root, "external-target"); await mkdir(externalTarget); await symlink(externalTarget, path.join(project, "linked"));
    await expect(applyDevelopmentResult({ ...base, workspace: managed, changes: { workspace: managed, status: "", diff: "", changedFiles: ["linked/file.txt"], deletedFiles: [] } }, project, workspaceRoot)).rejects.toThrow("symbolic link");
  });

  it("rejects a managed workspace directory that resolves through a symlink", async () => {
    const root = path.resolve(".tmp/tests", `delivery-symlink-${Date.now()}`); roots.push(root);
    const workspaceRoot = path.join(root, "workspaces"); const outsideRun = path.join(root, "outside-run");
    await mkdir(workspaceRoot, { recursive: true }); await mkdir(path.join(outsideRun, "primary"), { recursive: true }); await writeFile(path.join(outsideRun, "primary", ".keep"), "untouched");
    await symlink(outsideRun, path.join(workspaceRoot, "run_test"), process.platform === "win32" ? "junction" : "dir");
    const workspace = path.join(workspaceRoot, "run_test", "primary");
    const result = { sessionId: "session_test", runId: "run_test", workspace, placement: "isolated" as const, iterations: 1, completed: true, baselineCommit: "baseline", baselineRepository: path.join(workspace, ".git"), sourceRoot: root, changes: { workspace, status: "", diff: "", changedFiles: [], deletedFiles: [] }, evidence: [], reviews: [], delivery: { status: "pending" as const } };
    await expect(discardDevelopmentResult(result, workspaceRoot)).rejects.toThrow(/symbolic link|outside the managed Runtime workspace root/);
    expect(await readFile(path.join(outsideRun, "primary", ".keep"), "utf8")).toBe("untouched");
  });

  it("resolves the repository root when started from a nested package", async () => {
    const root = path.resolve(".tmp/tests", `nested-source-${Date.now()}`); roots.push(root); await mkdir(path.join(root, "apps", "server"), { recursive: true });
    const workspaceRoot = path.join("/tmp", `runharness-nested-workspaces-${Date.now()}`); roots.push(workspaceRoot);
    await writeFile(path.join(root, "README.md"), "# Test repo\n");
    await runProcess("git", ["init"], { cwd: root }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: root }); await runProcess("git", ["config", "user.name", "Test"], { cwd: root }); await runProcess("git", ["add", "."], { cwd: root }); await runProcess("git", ["commit", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "apps", "server", "uncommitted.ts"), "export const ready = true;\n");

    const prepared = await prepareDevelopmentWorkspace({ source: path.join(root, "apps", "server"), placement: "isolated", sessionId: "nested", workspaceRoot, runtimeRoot: workspaceRoot });

    expect(await readFile(path.join(prepared.workspace, "README.md"), "utf8")).toBe("# Test repo\n");
    expect(await readFile(path.join(prepared.workspace, "apps", "server", "uncommitted.ts"), "utf8")).toContain("ready = true");
  });

  it("reports only changes made after the run baseline in a dirty repository", async () => {
    const root = path.join(os.tmpdir(), `runharness-baseline-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "ignored-cache/\n");
    await writeFile(path.join(root, "existing-untracked.txt"), "keep\n");
    await mkdir(path.join(root, "ignored-cache")); await writeFile(path.join(root, "ignored-cache", "large.txt"), "ignored\n");
    const runtime = `${root}-runtime`; roots.push(runtime);
    const prepared = await prepareDevelopmentWorkspace({ source: root, placement: "in_place", sessionId: "baseline", workspaceRoot: path.join(runtime, "workspaces"), runtimeRoot: runtime });
    await writeFile(path.join(root, "new-change.txt"), "new\n"); await writeFile(path.join(root, "existing-untracked.txt"), "keep\n");
    const changes = await collectChangeSet(root, prepared.baseline, 20_000);
    expect(changes.changedFiles).toEqual(["new-change.txt"]); expect(changes.diff).not.toContain("existing-untracked"); expect(changes.diff).not.toContain("ignored-cache");
  });

  it("materializes only explicitly selected ignored paths", async () => {
    const root = path.join(os.tmpdir(), `runharness-ignored-${Date.now()}`); roots.push(root); await mkdir(path.join(root, "ignored", "nested"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "ignored/\ncache/\n");
    await writeFile(path.join(root, "ignored", "nested", "fixture.txt"), "needed\n");
    await mkdir(path.join(root, "cache")); await writeFile(path.join(root, "cache", "large.bin"), "omit\n");
    const runtime = `${root}-runtime`; roots.push(runtime);
    const prepared = await prepareDevelopmentWorkspace({ source: root, placement: "isolated", sessionId: "ignored", workspaceRoot: path.join(runtime, "workspaces"), runtimeRoot: runtime, materializeIgnored: ["ignored/nested"] });
    expect(await readFile(path.join(prepared.workspace, "ignored", "nested", "fixture.txt"), "utf8")).toBe("needed\n");
    await expect(readFile(path.join(prepared.workspace, "cache", "large.bin"), "utf8")).rejects.toThrow();
    await expect(prepareDevelopmentWorkspace({ source: root, placement: "isolated", sessionId: "escape", workspaceRoot: path.join(runtime, "workspaces"), runtimeRoot: runtime, materializeIgnored: ["../outside"] })).rejects.toThrow("escapes the project");
  });

  it("blocks Apply when the live source conflicts with the isolated delta", async () => {
    const root = path.join(os.tmpdir(), `runharness-conflict-${Date.now()}`); roots.push(root); const project = path.join(root, "project"); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(project, { recursive: true }); await writeFile(path.join(project, "same.txt"), "baseline\n");
    const prepared = await prepareDevelopmentWorkspace({ source: project, placement: "isolated", sessionId: "conflict", workspaceRoot, runtimeRoot: runtime });
    await writeFile(path.join(prepared.workspace, "same.txt"), "session\n"); await writeFile(path.join(project, "same.txt"), "live\n");
    const changes = await collectChangeSet(prepared.workspace, prepared.baseline);
    const result = { sessionId: "conflict", runId: "run", workspace: prepared.workspace, placement: "isolated" as const, iterations: 1, completed: true, baselineCommit: prepared.baseline.commit, baselineRepository: prepared.baseline.repository, sourceRoot: project, changes, evidence: [], reviews: [], delivery: { status: "pending" as const } };
    await expect(applyDevelopmentResult(result, project, workspaceRoot)).rejects.toThrow("Source changed after this Session began");
    expect(await readFile(path.join(project, "same.txt"), "utf8")).toBe("live\n");
    expect((await readWorkspaceRecord(runtime, "conflict"))?.state).toBe("ready");
  });

  it("blocks Apply until Session-owned auxiliary worktrees are reconciled", async () => {
    const root = path.join(os.tmpdir(), `runharness-auxiliary-${Date.now()}`); roots.push(root); const project = path.join(root, "project"); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(project, { recursive: true }); await writeFile(path.join(project, "base.txt"), "baseline\n");
    const prepared = await prepareDevelopmentWorkspace({ source: project, placement: "isolated", sessionId: "auxiliary", workspaceRoot, runtimeRoot: runtime });
    await writeFile(path.join(prepared.workspace, "primary.txt"), "primary\n");
    const auxiliary = path.join(path.dirname(prepared.workspace), "worktrees", "agent-task");
    const added = await runProcess("git", ["worktree", "add", "-b", "agent-task", auxiliary], { cwd: prepared.workspace }); expect(added.code).toBe(0);
    await writeFile(path.join(auxiliary, "agent.txt"), "unresolved\n");
    const changes = await collectChangeSet(prepared.workspace, prepared.baseline);
    const result = { sessionId: "auxiliary", runId: "run", workspace: prepared.workspace, placement: "isolated" as const, iterations: 1, completed: true, baselineCommit: prepared.baseline.commit, baselineRepository: prepared.baseline.repository, sourceRoot: project, changes, evidence: [], reviews: [], delivery: { status: "pending" as const } };
    await expect(applyDevelopmentResult(result, project, workspaceRoot)).rejects.toThrow("unresolved auxiliary worktrees");
    const record = await readWorkspaceRecord(runtime, "auxiliary");
    expect(record?.auxiliaryWorktrees).toEqual([expect.objectContaining({ dirty: true, ownership: "session" })]);
    expect(path.resolve(record!.auxiliaryWorktrees[0]!.path)).toContain(path.join("worktrees", "agent-task"));
  });

  it("retains owned workspaces and quarantines unowned directories", async () => {
    const root = path.join(os.tmpdir(), `runharness-reconcile-${Date.now()}`); roots.push(root); const source = path.join(root, "source"); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(source, { recursive: true }); await writeFile(path.join(source, "file.txt"), "baseline\n");
    const prepared = await prepareDevelopmentWorkspace({ source, placement: "isolated", sessionId: "session_owned", workspaceRoot, runtimeRoot: runtime });
    await mkdir(path.join(workspaceRoot, "orphan", "primary"), { recursive: true });
    expect(await reconcileManagedWorkspaces(runtime, workspaceRoot, new Set(["session_owned"]))).toMatchObject({ retained: 1, quarantined: 1 });
    expect((await readWorkspaceRecord(runtime, "session_owned"))?.state).toBe("ready");
    await rm(prepared.workspace, { recursive: true, force: true });
    expect(await reconcileManagedWorkspaces(runtime, workspaceRoot, new Set(["session_owned"]))).toMatchObject({ missing: 1 });
    expect((await readWorkspaceRecord(runtime, "session_owned"))?.state).toBe("missing");
  });

  it("quarantines malformed workspace records without blocking Runtime recovery", async () => {
    const root = path.join(os.tmpdir(), `runharness-record-reconcile-${Date.now()}`); roots.push(root); const runtime = path.join(root, "runtime"); const workspaceRoot = path.join(runtime, "workspaces");
    await mkdir(path.join(runtime, "workspace-records"), { recursive: true });
    await writeFile(path.join(runtime, "workspace-records", "broken.json"), "{not-json");
    expect(await reconcileManagedWorkspaces(runtime, workspaceRoot, new Set())).toMatchObject({ quarantined: 1 });
    const quarantined = await readdir(path.join(runtime, "quarantine", "workspace-records"));
    expect(quarantined.some((name) => name.startsWith("broken.json-"))).toBe(true);
  });

  it("plans, edits an isolated repository, verifies, reviews, and returns a diff", async () => {
    const root = path.resolve(".tmp/tests", `development-${Date.now()}`); roots.push(root); const repo = path.join(root, "source"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Test repo\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    const mock = path.join(root, "mock-coding-agent.mjs");
    await writeFile(mock, `#!/usr/bin/env node\nimport{writeFile}from'node:fs/promises';let input='';for await(const c of process.stdin)input+=c;const emit=(content)=>console.log(JSON.stringify({type:'assistant',message:{content}}));if(input.includes('Implement the approved plan')){await writeFile('feature.txt','session works\\n');emit([{type:'text',text:'Implemented feature.txt'}])}else if(input.includes('Review the current repository change')){emit([{type:'text',text:'The change is correct and verified.'},{type:'tool_use',id:'review',name:'mcp__runharness_control__review_accept',input:{}}]);console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'review',content:'recorded'}]}}))}else emit([{type:'text',text:'Plan: add feature.txt and verify its content.'}]);`);
    await chmod(mock, 0o755);
    const backend = { type: "cli" as const, command: "claude" as const, executable: mock };
    const config: ModelRoutingConfig = { agents: [
      { id: "planner", backend, enabled: true }, { id: "coder", backend, enabled: true }, { id: "reviewer", backend, enabled: true }
    ], stages: { planner: ["planner"], generator: ["coder"], evaluator: ["reviewer"] } };
    const data = path.join(root, "data"); const prompts = new PromptRegistry(data); const sessions = new JsonlSessionStore(data); await prompts.initialize();
    const result = await new DevelopmentHarness(new AgentPool(config), sessions, prompts, { acceptance: [{ kind: "command", name: "feature", runtime: "local-command", command: "test -f feature.txt && grep -q 'session works' feature.txt", required: true }], maxIterations: 2, maxDiffChars: 20_000 }).run({ goal: "Add a session proof file", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "isolated" });
    expect(result.completed).toBe(true); expect(result.placement).toBe("isolated"); expect(result.changes.changedFiles).toContain("feature.txt");
    expect(await readFile(path.join(result.workspace, "feature.txt"), "utf8")).toBe("session works\n");
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# Test repo\n");
    const eventTypes = (await sessions.getEvents(result.sessionId)).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["iteration_started", "agent_started", "agent_completed", "tool_call", "tool_result"]));
  });

  it("gives every Agent role the same writable policy and removes Run scratch", async () => {
    const root = path.join(os.tmpdir(), `runharness-role-policy-${Date.now()}`); roots.push(root); const project = path.join(root, "project"); const runtime = path.join(root, "runtime");
    await mkdir(project, { recursive: true }); await writeFile(path.join(project, "README.md"), "# policy\n");
    const sessions = new JsonlSessionStore(runtime); const prompts = new PromptRegistry(runtime); await prompts.initialize();
    const calls: Array<{ role: string; call: Omit<AgentCall, "role" | "model"> }> = [];
    const response = (backend: string, text: string): AgentResponse => ({ backend, text, durationMs: 1, metadata: {} });
    const pool = {
      capabilityAgents: () => [],
      contextBudgetChars: async () => 6_000,
      complete: async (role: string, call: Omit<AgentCall, "role" | "model">) => { calls.push({ role, call }); expect((await stat(call.environment!.TMPDIR!)).isDirectory()).toBe(true); return response(role, role === "planner" ? "Inspect and verify the project." : "No implementation change was needed."); },
      completeMany: async (role: string, call: Omit<AgentCall, "role" | "model">) => { calls.push({ role, call }); expect((await stat(call.environment!.TMPDIR!)).isDirectory()).toBe(true); await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review" }); await call.onActivity?.({ kind: "tool_result", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review", success: true }); return [response("reviewer", "The requested state is already satisfied.")]; },
    } as unknown as AgentPool;
    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 1, maxDiffChars: 20_000 }).run({ goal: "Verify the existing state", source: project, workspaceRoot: path.join(runtime, "workspaces"), runtimeRoot: runtime, placement: "in_place" });
    expect(result.completed).toBe(true);
    expect(calls.map(({ role, call }) => [role, call.options?.workspaceMode])).toEqual([["planner", "write"], ["generator", "write"], ["evaluator", "write"]]);
    const scratch = calls[0]!.call.environment!.TMPDIR!;
    expect(calls.every(({ call }) => call.writableRoots?.includes(scratch))).toBe(true);
    await expect(stat(scratch)).rejects.toThrow();
  });

  it("keeps a Provider turn alive while a concrete action waits for human approval", async () => {
    const root = path.join(os.tmpdir(), `runharness-live-permission-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); const data = path.join(root, "data");
    await mkdir(repo, { recursive: true }); await writeFile(path.join(repo, "README.md"), "# Permission\n");
    const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const response = (text: string): AgentResponse => ({ text, backend: "test", durationMs: 1, metadata: {} });
    let resolveApproval: ((decision: { requestId: string; decision: "approve"; scope: "session"; actor: "human"; createdAt: string }) => void) | undefined;
    let requestedId = "";
    const pool = {
      capabilityAgents: () => [],
      contextBudgetChars: async () => 8_000,
      complete: async (role: string, call: AgentCall) => {
        if (role === "planner") return response("Inspect the repository, then implement the requested change.");
        const action = { kind: "command" as const, summary: "Publish the package", command: "pnpm publish" };
        const decision = await call.permission!.decide(action, evaluatePermission(call.permission!.policy, action));
        expect(decision).toMatchObject({ decision: "allow", source: "human" });
        await writeFile(path.join(call.cwd, "approved.txt"), "approved\n");
        return response("The approved action completed.");
      },
      completeMany: async (_role: string, call: AgentCall) => {
        await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review" });
        await call.onActivity?.({ kind: "tool_result", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review", success: true });
        return [{ ...response("The approved result is present."), backend: "reviewer" }];
      },
    } as unknown as AgentPool;
    const task = new DevelopmentHarness(pool, sessions, prompts, { acceptance: [{ kind: "command", name: "approved", runtime: "local-command", command: "test -f approved.txt", required: true }], maxIterations: 1, maxDiffChars: 20_000 }).run({
      goal: "Create the approved result", source: repo, workspaceRoot: path.join(root, "workspaces"), runtimeRoot: data, placement: "in_place",
      requestApproval: (approval) => { requestedId = approval.id; return new Promise((resolve) => { resolveApproval = resolve; }); },
    });
    for (let attempt = 0; attempt < 100 && (await sessions.listSessions())[0]?.status !== "waiting_for_permission"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = (await sessions.listSessions())[0]!;
    expect(waiting.status).toBe("waiting_for_permission");
    expect((await sessions.getResult<{ pendingApproval?: { id: string } }>(waiting.id))?.pendingApproval?.id).toBe(requestedId);
    resolveApproval?.({ requestId: requestedId, decision: "approve", scope: "session", actor: "human", createdAt: new Date().toISOString() });
    const result = await task;
    expect(result.completed).toBe(true);
    expect((await sessions.getSession(waiting.id)).status).toBe("completed");
    const events = await sessions.getEvents(waiting.id);
    expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "approval_decided")).toHaveLength(1);
  });

  it("completes an accepted no-change Run after one iteration", async () => {
    const root = path.resolve(".tmp/tests", `accepted-no-change-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# No change required\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    let generatorCalls = 0; let reviewCalls = 0;
    const response = (text: string): AgentResponse => ({ text, backend: "test", durationMs: 1, metadata: {} });
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string) => { if (role === "generator") generatorCalls += 1; return response(role === "planner" ? "Inspect and report the current state." : "No repository change is required."); },
      completeMany: async (_role: string, call: AgentCall) => { reviewCalls += 1; await call.onActivity?.({ kind: "tool_call", backend: "test", tool: "runharness_control__review_accept", callId: "review" }); await call.onActivity?.({ kind: "tool_result", backend: "test", tool: "runharness_control__review_accept", callId: "review", success: true }); return [response("The no-change result correctly answers the request.")]; },
      contextBudgetChars: async () => 8_000,
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();

    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 3, maxDiffChars: 20_000 }).run({ goal: "Is the flow diagram still present?", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place" });

    expect(result.completed).toBe(true); expect(result.iterations).toBe(1); expect(result.changes.changedFiles).toEqual([]);
    expect(generatorCalls).toBe(1); expect(reviewCalls).toBe(1);
    const events = await sessions.getEvents(result.sessionId);
    expect(events.filter((event) => event.type === "iteration_started")).toHaveLength(1);
    expect(events.some((event) => event.type === "iteration_completed")).toBe(false);
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("recovers one missing review decision and requires its completed tool result", async () => {
    const root = path.resolve(".tmp/tests", `review-recovery-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Review recovery\n");
    await runProcess("git", ["init"], { cwd: repo });
    const response = (text: string): AgentResponse => ({ text, backend: "reviewer", durationMs: 1, metadata: {} });
    let recoveryCalls = 0;
    const pool = {
      capabilityAgents: () => [], contextBudgetChars: async () => 8_000,
      complete: async (role: string, call: AgentCall) => {
        if (role !== "evaluator") return response(role === "planner" ? "Inspect the current state." : "No change is required.");
        recoveryCalls += 1;
        await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "recovered" });
        await call.onActivity?.({ kind: "tool_result", backend: "reviewer", tool: "runharness_control__review_accept", callId: "recovered", success: true });
        return response("Lifecycle decision completed.");
      },
      completeMany: async (_role: string, call: AgentCall) => {
        await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "unfinished" });
        return [response("The implementation is acceptable, but the first control call did not complete.")];
      },
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 3, maxDiffChars: 20_000 }).run({ goal: "Confirm the current state", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place" });
    expect(recoveryCalls).toBe(1);
    expect(result).toMatchObject({ completed: true, iterations: 1, reviewStatus: "completed" });
    expect(result.reviews[0]).toMatchObject({ status: "completed", decision: "accept" });
  });

  it("fails once when review control remains unavailable instead of completing with pending review", async () => {
    const root = path.resolve(".tmp/tests", `review-unavailable-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Review unavailable\n");
    await runProcess("git", ["init"], { cwd: repo });
    const response = (text: string): AgentResponse => ({ text, backend: "reviewer", durationMs: 1, metadata: {} });
    let generatorCalls = 0; let recoveryCalls = 0;
    const pool = {
      capabilityAgents: () => [], contextBudgetChars: async () => 8_000,
      complete: async (role: string) => {
        if (role === "generator") generatorCalls += 1;
        if (role === "evaluator") recoveryCalls += 1;
        return response(role === "planner" ? "Inspect the current state." : role === "generator" ? "No change is required." : "Still no lifecycle decision.");
      },
      completeMany: async (_role: string, call: AgentCall) => {
        await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "unfinished" });
        return [response("Review prose without a completed control result.")];
      },
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 3, maxDiffChars: 20_000 }).run({ goal: "Confirm the current state", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place" });
    expect(generatorCalls).toBe(1); expect(recoveryCalls).toBe(1);
    expect(result).toMatchObject({ completed: false, iterations: 1, reviewStatus: "pending" });
    expect(result.reviews[0]).toMatchObject({ status: "control_missing", decision: "unavailable" });
    expect((await sessions.getSession(result.sessionId)).status).toBe("failed");
    const events = await sessions.getEvents(result.sessionId);
    expect(events.at(-1)?.type).toBe("run_failed");
  });

  it("continues a rejected no-change Run only to the configured iteration limit", async () => {
    const root = path.resolve(".tmp/tests", `rejected-no-change-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Changes required\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    let generatorCalls = 0; let reviewCalls = 0;
    const response = (text: string): AgentResponse => ({ text, backend: "test", durationMs: 1, metadata: {} });
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string) => { if (role === "generator") generatorCalls += 1; return response(role === "planner" ? "Implement the requested repository change." : "No change made."); },
      completeMany: async (_role: string, call: AgentCall) => { reviewCalls += 1; await call.onActivity?.({ kind: "tool_call", backend: "test", tool: "runharness_control__review_request_changes", callId: "review" }); await call.onActivity?.({ kind: "tool_result", backend: "test", tool: "runharness_control__review_request_changes", callId: "review", success: true }); return [response("The requested change is still missing.")]; },
      contextBudgetChars: async () => 8_000,
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();

    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 2, maxDiffChars: 20_000 }).run({ goal: "Change the repository", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place" });

    expect(result.completed).toBe(false); expect(result.iterations).toBe(2); expect(result.changes.changedFiles).toEqual([]);
    expect(generatorCalls).toBe(2); expect(reviewCalls).toBe(2);
    const events = await sessions.getEvents(result.sessionId);
    expect(events.filter((event) => event.type === "iteration_started")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run_failed");
  });

  it("persists a proposed Plan and resumes the same Run only after approval", async () => {
    const root = path.resolve(".tmp/tests", `plan-gate-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Plan gate\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    const response = (text: string): AgentResponse => ({ text, backend: "test", durationMs: 1, metadata: {} });
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string, call: AgentCall) => {
        if (role === "generator") { await writeFile(path.join(call.cwd, "approved.txt"), "approved\n"); return response("implemented"); }
        return response("Plan: create approved.txt and verify it.");
      },
      completeMany: async (_role: string, call: AgentCall) => { await call.onActivity?.({ kind: "tool_call", backend: "test", tool: "mcp__runharness_control__review_accept", callId: "review" }); await call.onActivity?.({ kind: "tool_result", backend: "test", tool: "mcp__runharness_control__review_accept", callId: "review", success: true }); return [response("The implementation matches the requested behavior.")]; },
      contextBudgetChars: async () => 8_000,
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const harness = new DevelopmentHarness(pool, sessions, prompts, { acceptance: [{ kind: "command", name: "approved", runtime: "local-command", command: "test -f approved.txt", required: true }], maxIterations: 1, maxDiffChars: 20_000 });
    const waiting = await harness.run({ goal: "Create the approved file", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "isolated", planReview: "require_approval" });
    expect(waiting.plan?.status).toBe("proposed");
    expect((await sessions.getSession(waiting.sessionId)).status).toBe("waiting_for_plan_approval");
    await expect(readFile(path.join(waiting.workspace, "approved.txt"), "utf8")).rejects.toThrow();
    const completed = await harness.run({ goal: "Create the approved file", originalGoal: "Create the approved file", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "isolated", sessionId: waiting.sessionId, resumeWorkspace: waiting.workspace, baselineCommit: waiting.baselineCommit, baselineRepository: waiting.baselineRepository, sourceRoot: waiting.sourceRoot, approvedPlan: { ...waiting.plan!, status: "approved" } });
    expect(completed.runId).toBe(waiting.runId);
    expect(completed.completed).toBe(true);
    expect((await sessions.getSession(waiting.sessionId)).status).toBe("completed");
  });

  it("preserves Planner output without interpreting or replacing it", async () => {
    const root = path.resolve(".tmp/tests", `plan-fallback-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Plan fallback\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    const response = (text: string, agentId: string): AgentResponse => ({ text, backend: agentId, durationMs: 1, metadata: { agentId } });
    const selections: Array<{ preferred?: string; exclude?: string[] }> = [];
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string, call: AgentCall, selection: { preferred?: string; exclude?: string[] } = {}) => {
        if (role === "generator") { await writeFile(path.join(call.cwd, "fallback.txt"), "ready\n"); return response("Implemented fallback Plan.", "coder"); }
        selections.push(selection);
        return response("I'll inspect the repository before drafting a plan.", "grok");
      },
      completeMany: async (_role: string, call: AgentCall) => { await call.onActivity?.({ kind: "tool_call", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review" }); await call.onActivity?.({ kind: "tool_result", backend: "reviewer", tool: "runharness_control__review_accept", callId: "review", success: true }); return [response("The change is ready.", "reviewer")]; },
      contextBudgetChars: async () => 8_000,
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const result = await new DevelopmentHarness(pool, sessions, prompts, { acceptance: [{ kind: "command", name: "fallback", runtime: "local-command", command: "test -f fallback.txt", required: true }], maxIterations: 1, maxDiffChars: 20_000 }).run({ goal: "Add fallback proof", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place" });
    expect(selections).toEqual([{}]);
    expect(result.plan?.text).toBe("I'll inspect the repository before drafting a plan.");
    expect(result.completed).toBe(true);
  });

  it("passes the same managed images to planner, generator, and evaluators", async () => {
    const root = path.resolve(".tmp/tests", `development-images-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Images\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    const image = { id: "image_test", name: "screen.png", mediaType: "image/png" as const, size: 8, filePath: path.join(root, "managed.image") };
    await writeFile(image.filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const seen: Array<{ role: string; images: AgentCall["images"] }> = [];
    const response = (text: string): AgentResponse => ({ text, backend: "test", durationMs: 1, metadata: {} });
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string, call: AgentCall) => {
        seen.push({ role, images: call.images });
        if (role === "generator") await writeFile(path.join(call.cwd, "image-result.txt"), "used\n");
        return response(role === "planner" ? "Plan: create image-result.txt from the supplied image context and verify the file exists." : "Implemented image change");
      },
      completeMany: async (role: string, call: AgentCall) => {
        seen.push({ role, images: call.images });
        await call.onActivity?.({ kind: "tool_call", backend: "test", tool: "runharness_control.review_accept", callId: "review" });
        await call.onActivity?.({ kind: "tool_result", backend: "test", tool: "runharness_control.review_accept", callId: "review", success: true });
        return [response("Image context reviewed")];
      },
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const prompts = new PromptRegistry(data); await prompts.initialize();
    const result = await new DevelopmentHarness(pool, new JsonlSessionStore(data), prompts, { acceptance: [{ kind: "command", name: "image-result", runtime: "local-command", command: "test -f image-result.txt", required: true }], maxIterations: 1, maxDiffChars: 20_000 }).run({ goal: "Use image context", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place", images: [image] });
    expect(result.completed).toBe(true);
    expect(seen.map((entry) => entry.role)).toEqual(["planner", "generator", "evaluator"]);
    expect(seen.every((entry) => entry.images?.[0]?.id === image.id)).toBe(true);
    const events = await new JsonlSessionStore(data).getEvents(result.sessionId);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("screen.png");
    expect(serialized).not.toContain(image.filePath);
  });

  it("stops the whole Run on abort without entering review", async () => {
    const root = path.resolve(".tmp/tests", `development-abort-${Date.now()}`); roots.push(root); const repo = path.join(root, "repo"); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Abort\n");
    await runProcess("git", ["init"], { cwd: repo }); await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: repo }); await runProcess("git", ["config", "user.name", "Test"], { cwd: repo }); await runProcess("git", ["add", "."], { cwd: repo }); await runProcess("git", ["commit", "-m", "initial"], { cwd: repo });
    let reviewCalls = 0;
    const pool = {
      capabilityAgents: () => [],
      complete: async (role: string, call: AgentCall) => {
        if (role === "planner") return { text: "Plan", backend: "planner", durationMs: 1, metadata: {} };
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(Object.assign(new Error("Run interrupted"), { name: "AbortError" }));
          if (call.signal?.aborted) stop(); else call.signal?.addEventListener("abort", stop, { once: true });
        });
        throw new Error("unreachable");
      },
      completeMany: async () => { reviewCalls += 1; return []; },
      contextBudgetChars: async () => 8_000,
    } as unknown as AgentPool;
    const data = path.join(root, "data"); const sessions = new JsonlSessionStore(data); const prompts = new PromptRegistry(data); await prompts.initialize();
    const controller = new AbortController();
    const task = new DevelopmentHarness(pool, sessions, prompts, { acceptance: [], maxIterations: 2, maxDiffChars: 20_000 }).run({ goal: "Stop everything", source: repo, workspaceRoot: path.join(root, "workspaces"), placement: "in_place", signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    const session = (await sessions.listSessions())[0]!;
    expect(session.status).toBe("stopped");
    expect(reviewCalls).toBe(0);
    expect((await sessions.getEvents(session.id)).filter((event) => event.type === "run_stopped")).toHaveLength(1);
  });
});
