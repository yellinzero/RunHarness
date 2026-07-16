#!/usr/bin/env node
import path from "node:path";
import { resolveProjectRoot } from "@runharness/development";
import { AgentPool, loadModelConfig } from "@runharness/providers";
import { resolveProjectStorage } from "@runharness/server";
import { parseRunOptions } from "./commands/arguments.js";
import { cleanData, describeData, formatSummary } from "./commands/maintenance.js";
import { runPrintMode } from "./commands/print.js";
import { launchTui } from "./ui/tui.js";

const input = process.argv.slice(2);
const [command, ...args] = input;

if (command === "web") {
  throw new Error("Web is part of the TUI Runtime. Use 'runharness --web' or open '/dashboard' inside the TUI.");
} else if (command === "agents") {
  const projectDir = await resolveProjectRoot(process.cwd());
  const storage = resolveProjectStorage(projectDir);
  const config = await loadModelConfig(projectDir, process.env.RUNHARNESS_CONFIG ?? path.join(storage.dataDir, "config.json"));
  const pool = new AgentPool(config, projectDir);
  console.log(JSON.stringify({ agents: await pool.status(), mcpServers: await pool.mcpStatus(), stages: config.stages }, null, 2));
} else if (command === "data") {
  const unknown = args.find((value) => value !== "--all");
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
  console.log(formatSummary(await describeData(args.includes("--all"))));
} else if (command === "clean") {
  const unknown = args.find((value) => value !== "--all" && value !== "--yes" && value !== "-y");
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
  const removed = await cleanData({ all: args.includes("--all"), yes: args.includes("--yes") || args.includes("-y") });
  console.log(removed ? `Deleted ${removed.directory}` : "No data deleted.");
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`RunHarness\n\n  runharness                              Open the project TUI (prefers port 8888)\n  runharness "goal"                       Open the TUI and start a goal\n  runharness --web                        Open the TUI and browser control plane\n  runharness --web --port 8888            Require a specific control-plane port\n  runharness -p "goal"                    Run once without a TUI\n  runharness -p --placement isolated "goal" Run once in an isolated workspace\n  runharness --max-iterations 5           Override iterations for this run\n  runharness --placement isolated         Open the TUI with isolated placement\n  runharness agents                       Show configured model routes\n  runharness data [--all]                 Show stored data and size\n  runharness clean [--all]                Delete stored data after confirmation\n  runharness clean --all --yes            Delete all data without prompting`);
} else {
  const parsed = parseRunOptions(input);
  if (parsed.print) {
    if (!parsed.goal) throw new Error("-p/--print requires a goal");
    if (!await runPrintMode(parsed.goal, parsed.placement, process.cwd(), parsed.maxIterations)) process.exitCode = 2;
  } else {
    await launchTui(process.cwd(), parsed.goal, parsed.web, parsed.placement === "in_place" ? "in-place" : parsed.placement, parsed.maxIterations, parsed.port);
  }
}
