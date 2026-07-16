import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.join(root, "packages/cli");
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

if (manifest.name !== "runharness" || manifest.private === true) {
  throw new Error("packages/cli must be the public 'runharness' package");
}
if (manifest.bin?.runharness !== "./dist/index.js") {
  throw new Error("The runharness bin must point to ./dist/index.js");
}

for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  if (String(version).startsWith("workspace:")) {
    throw new Error(`Runtime dependency '${name}' cannot use the workspace protocol`);
  }
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", packageRoot], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, npm_config_loglevel: "silent" },
});
if (packed.status !== 0) {
  throw new Error(packed.stderr.trim() || "npm pack --dry-run failed");
}

let report;
try {
  [report] = JSON.parse(packed.stdout);
} catch {
  throw new Error(`npm pack returned invalid JSON: ${packed.stdout.slice(0, 500)}`);
}

const files = new Set(report.files.map((file) => file.path));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/dashboard/index.html",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
];
for (const file of requiredFiles) {
  if (!files.has(file)) throw new Error(`Published package is missing '${file}'`);
}

const forbidden = [...files].filter((file) => file.startsWith("src/") || file.includes(".test."));
if (forbidden.length) {
  throw new Error(`Published package contains development files: ${forbidden.join(", ")}`);
}

console.log(`Verified ${manifest.name}@${manifest.version}: ${files.size} files, ${report.size} bytes packed`);
