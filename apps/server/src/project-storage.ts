import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface ProjectStorage {
  home: string;
  projectId: string;
  dataDir: string;
  progressDir: string;
  workspacesDir: string;
}

/** 将绝对项目路径映射到稳定的用户级应用数据目录。 */
export function resolveProjectStorage(projectDir: string, home = defaultRunHarnessHome()): ProjectStorage {
  const root = path.resolve(projectDir);
  const projectId = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const dataDir = path.join(path.resolve(home), "projects", projectId);
  return {
    home: path.resolve(home),
    projectId,
    dataDir,
    progressDir: path.join(dataDir, "progress"),
    workspacesDir: path.join(dataDir, "workspaces"),
  };
}

export function defaultRunHarnessHome(): string {
  return path.resolve(process.env.RUNHARNESS_HOME ?? path.join(os.homedir(), ".runharness"));
}
