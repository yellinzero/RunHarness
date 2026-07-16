import { describe, expect, it } from "vitest";
import { controlMcpServer } from "@runharness/providers";
import type { AcceptanceSpec } from "@runharness/shared";
import { ExecutionRuntimeRegistry, LocalCommandRuntime, ProjectMcpRuntime, type ExecutionRuntime } from "../runtime/execution-runtime.js";
import { requiredAcceptancePassed } from "../verification/acceptance.js";

const command = (patch: Partial<Extract<AcceptanceSpec, { kind: "command" }>> = {}): Extract<AcceptanceSpec, { kind: "command" }> => ({
  kind: "command", name: "command", runtime: "local-command", command: "true", required: true, ...patch,
});

describe("execution Runtimes and evidence", () => {
  it("keeps optional unavailable evidence non-blocking and required evidence blocking", async () => {
    const runtimes = new ExecutionRuntimeRegistry([]);
    const optional = await runtimes.execute(command({ runtime: "missing", required: false }), { workspace: process.cwd() });
    const required = await runtimes.execute(command({ runtime: "missing" }), { workspace: process.cwd() });
    expect(optional).toMatchObject({ status: "unavailable", placement: "unknown", requirement: "optional", blocksCompletion: false, failureCategory: "missing_dependency" });
    expect(required).toMatchObject({ status: "unavailable", requirement: "required", blocksCompletion: true });
    expect(requiredAcceptancePassed([optional])).toBe(true);
    expect(requiredAcceptancePassed([optional, required])).toBe(false);
  });

  it("attributes a browser-style macOS launch denial to the host command sandbox boundary", async () => {
    const runtimes = new ExecutionRuntimeRegistry([new LocalCommandRuntime()]);
    const result = await runtimes.execute(command({ command: "echo 'bootstrap_check_in: Operation not permitted' >&2; exit 1" }), { workspace: process.cwd() });
    expect(result).toMatchObject({ owner: "runharness", placement: "host", status: "failed", failureCategory: "sandbox", blocksCompletion: true });
    await runtimes.stop();
  });

  it("applies project command rules before starting a configured host command", async () => {
    const runtimes = new ExecutionRuntimeRegistry([new LocalCommandRuntime()]);
    const result = await runtimes.execute(command({ command: "echo forbidden" }), {
      workspace: process.cwd(),
      permission: {
        policy: { workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "allow_all", customRules: [{ id: "deny-forbidden", scope: "command", pattern: "*forbidden*", decision: "deny" }] },
        decide: async (_action, decision) => decision,
      },
    });
    expect(result).toMatchObject({ status: "denied", failureCategory: "permission", blocksCompletion: true });
    await runtimes.stop();
  });

  it("preserves ask as a durable Harness approval signal", async () => {
    const runtimes = new ExecutionRuntimeRegistry([new LocalCommandRuntime()]);
    await expect(runtimes.execute(command({ command: "echo confirm-me" }), {
      workspace: process.cwd(),
      permission: {
        policy: { workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "allow_all", customRules: [{ id: "ask-confirm", scope: "command", pattern: "*confirm-me*", decision: "ask" }] },
        decide: async (_action, decision) => decision,
      },
    })).rejects.toMatchObject({ name: "PermissionRequiredError" });
    await runtimes.stop();
  });

  it("cancels an active child command and closes the evidence lifecycle", async () => {
    const runtimes = new ExecutionRuntimeRegistry([new LocalCommandRuntime()]);
    const controller = new AbortController();
    const pending = runtimes.execute(command({ command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` }), { workspace: process.cwd(), signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).resolves.toMatchObject({ status: "cancelled", failureCategory: "cancelled", blocksCompletion: true });
    await runtimes.stop();
  });

  it("starts project MCP only when requested and records its actual placement", async () => {
    const runtime = new ProjectMcpRuntime({ runharness_control: controlMcpServer("review") });
    const runtimes = new ExecutionRuntimeRegistry([runtime]);
    expect(runtime.descriptor).toMatchObject({ placement: "host", owner: "runharness", controlled: true });
    const result = await runtimes.execute({ kind: "tool", name: "review signal smoke", runtime: "project-mcp", tool: "mcp__runharness_control__review_accept", input: {}, required: false }, { workspace: process.cwd() });
    expect(result).toMatchObject({ status: "passed", runtimeId: "project-mcp", requirement: "optional", blocksCompletion: false });
    await runtimes.stop();
  });

  it("accepts a VM scenario Runtime without changing the acceptance loop", async () => {
    const vm: ExecutionRuntime = {
      descriptor: { id: "test-vm", label: "Test VM", owner: "external", placement: "vm", capabilities: ["scenario"], controlled: true, detail: "Fixture VM", limitations: [] },
      start: async () => undefined,
      execute: async (spec) => spec.kind === "scenario" ? { status: "passed", summary: `Scenario ${spec.scenario} passed` } : { status: "unavailable", summary: "Unsupported", failureCategory: "missing_dependency" },
      stop: async () => undefined,
    };
    const result = await new ExecutionRuntimeRegistry([vm]).execute({ kind: "scenario", name: "desktop flow", runtime: "test-vm", scenario: "open app and save", required: true }, { workspace: process.cwd() });
    expect(result).toMatchObject({ status: "passed", placement: "vm", capability: "scenario", blocksCompletion: false });
  });
});
