import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerRuntime } from "@runharness/server";
import { cleanData, describeData } from "../commands/maintenance.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CLI data maintenance", () => {
  it("reports and deletes all user data only after approval", async () => {
    const home = path.resolve(".tmp/tests", `maintenance-${Date.now()}`); roots.push(home);
    const session = path.join(home, "projects", "project", "sessions", "session-1");
    await mkdir(session, { recursive: true });
    await writeFile(path.join(session, "session.json"), "test data");

    const summary = await describeData(true, process.cwd(), home);
    expect(summary.sessions).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(await cleanData({ all: true, yes: false, home, confirm: async () => false })).toBeUndefined();
    await expect(access(home)).resolves.toBeUndefined();

    expect(await cleanData({ all: true, yes: true, home })).toMatchObject({ sessions: 1 });
    await expect(access(home)).rejects.toThrow();
  });

  it("refuses to delete all data while a Runtime is active", async () => {
    const home = path.resolve(".tmp/tests", `maintenance-active-${Date.now()}`); roots.push(home);
    await mkdir(path.join(home, "projects"), { recursive: true });
    await writeFile(path.join(home, "data.txt"), "data");
    const runtime = await registerRuntime("/tmp/active-project", "http://127.0.0.1:4999", home);
    await expect(cleanData({ all: true, yes: true, home })).rejects.toThrow("Stop active");
    await runtime.stop();
  });
});
