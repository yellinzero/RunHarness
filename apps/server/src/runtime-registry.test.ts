import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectRuntime, listRuntimes, registerRuntime } from "./runtime-registry.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("runtime registry", () => {
  it("discovers concurrent project runtimes and unregisters on stop", async () => {
    const root = path.resolve(".tmp/tests", `runtime-registry-${Date.now()}`); roots.push(root); await mkdir(root, { recursive: true });
    const first = await registerRuntime("/tmp/project-a", "http://127.0.0.1:4101", root);
    const second = await registerRuntime("/tmp/project-b", "http://127.0.0.1:4102", root);

    expect((await listRuntimes(root)).map((item) => item.projectName)).toEqual(["project-a", "project-b"]);
    expect((await findProjectRuntime("/tmp/project-a/../project-a", root))?.url).toBe("http://127.0.0.1:4101");

    await first.stop();
    expect((await listRuntimes(root)).map((item) => item.projectName)).toEqual(["project-b"]);
    await second.stop();
  });
});
