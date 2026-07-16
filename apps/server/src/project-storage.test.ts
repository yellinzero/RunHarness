import { describe, expect, it } from "vitest";
import { resolveProjectStorage } from "./project-storage.js";

describe("project storage", () => {
  it("maps projects to stable isolated user-level directories", () => {
    const first = resolveProjectStorage("/tmp/project-a", "/tmp/runharness-home");
    const repeated = resolveProjectStorage("/tmp/project-a", "/tmp/runharness-home");
    const second = resolveProjectStorage("/tmp/project-b", "/tmp/runharness-home");

    expect(first).toEqual(repeated);
    expect(first.dataDir).toContain("/tmp/runharness-home/projects/");
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.dataDir).not.toBe(second.dataDir);
  });
});
