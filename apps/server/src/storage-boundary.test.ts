import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, resolveProjectStorage } from "./index.js";

const root = path.resolve(".tmp/tests", `storage-boundary-${Date.now()}`);

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("server storage boundary", () => {
  it("stores project data under RUNHARNESS_HOME instead of the project directory", async () => {
    const projectDir = path.join(root, "project");
    const home = path.join(root, "home");
    await mkdir(projectDir, { recursive: true });
    vi.stubEnv("RUNHARNESS_HOME", home);

    const app = await buildServer({ projectDir });
    await app.close();

    const storage = resolveProjectStorage(projectDir, home);
    await expect(access(path.join(storage.dataDir, "schema.json"))).resolves.toBeUndefined();
    await expect(access(path.join(projectDir, ".runharness"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
