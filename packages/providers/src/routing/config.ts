import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition, AgentRole, ModelRoutingConfig } from "@runharness/shared";
import { commandExists } from "../runtime/process.js";

export const exampleModelConfig: ModelRoutingConfig = {
  acceptance: [],
  mcpServers: {
    playwright: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      enabled: true,
      disabledTools: ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"],
      startupTimeoutMs: 30_000,
      toolTimeoutMs: 120_000,
    },
  },
  agents: [
    { id: "claude", enabled: true, backend: { type: "cli", command: "claude", timeoutMs: 600_000 } },
    { id: "codex", enabled: true, backend: { type: "cli", command: "codex", timeoutMs: 600_000 } },
    { id: "grok", enabled: true, backend: { type: "cli", command: "grok", timeoutMs: 600_000 } },
    { id: "grok-api", enabled: false, model: "grok-4", backend: { type: "api", protocol: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" } },
  ],
  stages: {
    planner: ["claude"],
    generator: ["codex"],
    evaluator: ["claude"],
  },
};

export async function loadModelConfig(cwd = process.cwd(), file = process.env.RUNHARNESS_CONFIG): Promise<ModelRoutingConfig> {
  const target = path.resolve(cwd, file ?? "runharness.config.json");
  try {
    await access(target);
    return JSON.parse(await readFile(target, "utf8")) as ModelRoutingConfig;
  } catch {
    const config = structuredClone(exampleModelConfig);
    setAgentEnvironment(config.agents, "claude", "CLAUDE_CONFIG_DIR", process.env.RUNHARNESS_CLAUDE_CONFIG_DIR);
    setAgentEnvironment(config.agents, "codex", "CODEX_HOME", process.env.RUNHARNESS_CODEX_HOME);
    setAgentEnvironment(config.agents, "grok", "GROK_HOME", process.env.RUNHARNESS_GROK_HOME);
    const available = new Map(await Promise.all(["claude", "codex", "grok"].map(async (command) => [command, await commandExists(command)] as const)));
    for (const agent of config.agents) if (agent.backend.type === "cli") agent.enabled = available.get(agent.backend.command) ?? false;
    selectAvailableDefaults(config, available);
    return config;
  }
}

export function validateModelConfig(value: unknown): asserts value is ModelRoutingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent configuration must be an object");
  const config = value as Partial<ModelRoutingConfig>;
  if (!Array.isArray(config.agents) || !config.stages) throw new Error("agents and stages are required");
  const ids = new Set<string>();
  for (const agent of config.agents) {
    if (!agent || typeof agent !== "object" || !/^[A-Za-z0-9_-]+$/.test(agent.id ?? "")) throw new Error("Every Agent requires an id containing only letters, numbers, '_' or '-'");
    if (ids.has(agent.id)) throw new Error(`Duplicate Agent id '${agent.id}'`);
    ids.add(agent.id);
    if (typeof agent.enabled !== "boolean") throw new Error(`Agent '${agent.id}' enabled must be boolean`);
    if (!agent.backend || (agent.backend.type !== "cli" && agent.backend.type !== "api")) throw new Error(`Agent '${agent.id}' requires a backend`);
    if (agent.backend.type === "cli") {
      if (!agent.backend.command?.trim()) throw new Error(`Agent '${agent.id}' requires a CLI command`);
      if (agent.backend.args && agent.backend.args.some((item) => typeof item !== "string")) throw new Error(`Agent '${agent.id}' args must contain strings`);
      if (agent.backend.env && Object.values(agent.backend.env).some((item) => typeof item !== "string")) throw new Error(`Agent '${agent.id}' env must contain string values`);
    }
    if (agent.backend.type === "api" && (!agent.backend.protocol || !agent.backend.apiKeyEnv?.trim())) throw new Error(`Agent '${agent.id}' requires API protocol and apiKeyEnv`);
  }
  for (const stage of ["planner", "generator", "evaluator"] as const) {
    const assigned = config.stages[stage];
    if (!Array.isArray(assigned) || assigned.some((id) => typeof id !== "string" || !ids.has(id))) throw new Error(`Stage '${stage}' contains an unknown Agent`);
    if (new Set(assigned).size !== assigned.length) throw new Error(`Stage '${stage}' contains a duplicate Agent`);
    if (assigned.length === 0) throw new Error(`Stage '${stage}' requires at least one Agent`);
  }
  if (config.acceptance !== undefined) {
    if (!Array.isArray(config.acceptance)) throw new Error("acceptance must be an array");
    const names = new Set<string>();
    for (const check of config.acceptance) {
      const actionValid = check?.kind === "command" ? Boolean(check.command?.trim())
        : check?.kind === "tool" ? Boolean(check.tool?.trim()) && Boolean(check.input) && typeof check.input === "object" && !Array.isArray(check.input)
        : check?.kind === "scenario" ? Boolean(check.scenario?.trim())
        : false;
      if (!check?.name?.trim() || names.has(check.name) || !check.runtime?.trim() || !actionValid || typeof check.required !== "boolean" || (check.timeoutMs !== undefined && (!Number.isFinite(check.timeoutMs) || check.timeoutMs <= 0)))
        throw new Error("Every acceptance spec requires a unique name, runtime, valid action, required flag, and optional positive timeoutMs");
      names.add(check.name);
    }
  }
}

function setAgentEnvironment(agents: AgentDefinition[], id: string, key: string, value: string | undefined) {
  if (!value) return;
  const agent = agents.find((item) => item.id === id);
  if (agent?.backend.type === "cli") agent.backend.env = { ...agent.backend.env, [key]: value };
}

function selectAvailableDefaults(config: ModelRoutingConfig, available: Map<string, boolean>) {
  const first = (...ids: string[]) => ids.find((id) => available.get(id)) ?? ids[0]!;
  const defaults: Record<AgentRole, string> = {
    planner: first("claude", "codex", "grok"),
    generator: first("codex", "claude", "grok"),
    evaluator: first("claude", "grok", "codex"),
  };
  config.stages.planner = [defaults.planner];
  config.stages.generator = [defaults.generator];
  config.stages.evaluator = [defaults.evaluator];
}
