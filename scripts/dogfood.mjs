import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, ".tmp", "dogfood");
const manifestPath = path.join(outputDir, "manifest.json");
const command = process.argv[2];

try { await main(); }
catch (error) { console.error(`Dogfood failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

async function main() {
  if (command === "prepare") await prepare();
  else if (command === "activate") await activate();
  else {
    console.log("RunHarness dogfood\n\n  pnpm dogfood:prepare   verify and package inside the active Run\n  pnpm dogfood:activate  after the old Runtime exits, install and launch the new build");
    if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
  }
}

async function prepare() {
  await mkdir(outputDir, { recursive: true });
  await rm(manifestPath, { force: true });
  run("pnpm", ["lint"]);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);
  run("pnpm", ["build"]);
  run("pnpm", ["package:check"]);
  const packageVersion = JSON.parse(await readFile(path.join(root, "packages", "cli", "package.json"), "utf8")).version;
  const packedArtifact = path.join(outputDir, `runharness-${packageVersion}.tgz`);
  await rm(packedArtifact, { force: true });
  run("pnpm", ["--filter", "runharness", "pack", "--pack-destination", outputDir]);
  if (!(await readdir(outputDir)).includes(path.basename(packedArtifact))) throw new Error("RunHarness pack did not create the expected tarball");
  const bytes = await readFile(packedArtifact);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = path.join(outputDir, `runharness-${packageVersion}-dogfood-${sha256.slice(0, 12)}.tgz`);
  await rename(packedArtifact, artifact);
  const bundleSha256 = await fileDigest(path.join(root, "packages", "cli", "dist", "index.js"));
  const manifest = {
    artifact,
    sha256,
    bundleSha256,
    preparedAt: new Date().toISOString(),
    sourceRevision: capture("git", ["rev-parse", "HEAD"]).trim(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nDogfood package ready\n  artifact: ${artifact}\n  sha256:  ${manifest.sha256}\n  bundle:  ${manifest.bundleSha256}\n\nDo not activate it from the active Run. After this Run reaches a terminal state, exit the old TUI and run:\n  pnpm dogfood:activate`);
}

async function activate() {
  const runtime = await liveProjectRuntime();
  if (runtime) throw new Error(`RunHarness is still serving this project at ${runtime.url}. Let the Run finish and exit the old TUI before activation.`);

  const manifest = await readFile(manifestPath, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => { throw new Error("No prepared dogfood package was found; run pnpm dogfood:prepare first"); });
  if (!manifest || typeof manifest.artifact !== "string" || typeof manifest.sha256 !== "string" || typeof manifest.bundleSha256 !== "string") throw new Error("Dogfood manifest is invalid; run pnpm dogfood:prepare again");
  const bytes = await readFile(manifest.artifact);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.sha256) throw new Error("Dogfood artifact digest changed; run pnpm dogfood:prepare again");

  const globalRoot = capture("pnpm", ["root", "--global"]).trim();
  const globalManifest = await readFile(path.join(path.dirname(globalRoot), "package.json"), "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => undefined);
  // pnpm 会重新解析全局项目中的所有 file: 依赖；先移除旧记录，避免已清理的历史 tarball 阻断升级。
  if (globalManifest?.dependencies?.runharness) run("pnpm", ["remove", "--global", "runharness"]);
  run("pnpm", ["add", "--global", manifest.artifact]);
  const installedBundle = path.join(globalRoot, "runharness", "dist", "index.js");
  const installedDigest = await fileDigest(installedBundle).catch(() => undefined);
  if (installedDigest !== manifest.bundleSha256) {
    throw new Error(`Installed RunHarness bundle does not match the prepared package (${installedDigest ?? "missing"} != ${manifest.bundleSha256})`);
  }
  run("runharness", ["--help"]);
  console.log("\nInstalled the prepared RunHarness package. The production TUI will start now. Reopen the previous Session and use /continue for installed-runtime verification.\n");
  run("runharness", ["--web"]);
}

async function liveProjectRuntime() {
  const home = process.env.RUNHARNESS_HOME ? path.resolve(process.env.RUNHARNESS_HOME) : path.join(homedir(), ".runharness");
  const directory = path.join(home, "runtimes");
  let entries;
  try { entries = await readdir(directory); }
  catch { return undefined; }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const registration = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (path.resolve(registration.projectDir) !== root || typeof registration.url !== "string") continue;
      const response = await fetch(`${registration.url}/api/runtime`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return registration;
    } catch { /* 忽略陈旧或不属于当前项目的 Runtime 注册。 */ }
  }
  return undefined;
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
}

function capture(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, env: process.env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${executable} exited with ${result.status ?? "no status"}`);
  return result.stdout;
}

async function fileDigest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
