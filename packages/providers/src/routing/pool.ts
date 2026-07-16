import type {
  AgentDefinition,
  AgentModelDiscovery,
  AgentRole,
  ModelRoutingConfig,
} from "@runharness/shared";
import { ApiAgentBackend } from "../backends/api.js";
import { CliAgentBackend } from "../backends/cli.js";
import type { AgentBackend, AgentCall, AgentResponse } from "../runtime/backend.js";
import { ProviderConversationStore } from "../runtime/conversations.js";
import { isAbortError } from "../runtime/process.js";
import { withControlMcp } from "../tools/control-tools.js";
import { discoverMcpServers, PermissionRequiredError } from "../tools/mcp.js";

export interface AgentSelection {
  preferred?: string;
  exclude?: string[];
}

/** 统一处理角色路由、失败回退、能力发现和可恢复的 Provider 会话。 */
export class AgentPool {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly backends = new Map<string, AgentBackend>();
  private readonly conversations: ProviderConversationStore;

  constructor(readonly config: ModelRoutingConfig, private readonly projectDir = process.cwd(), runtimeRoot?: string) {
    this.conversations = new ProviderConversationStore(runtimeRoot);
    for (const agent of config.agents) {
      if (this.agents.has(agent.id)) throw new Error(`Duplicate Agent id '${agent.id}'`);
      this.agents.set(agent.id, agent);
      this.backends.set(agent.id, agent.backend.type === "cli"
        ? new CliAgentBackend(agent.id, agent.backend)
        : new ApiAgentBackend(agent.id, agent.backend));
    }
    for (const [stage, agentIds] of Object.entries(config.stages)) {
      for (const agentId of agentIds) if (!this.agents.has(agentId)) throw new Error(`Stage '${stage}' references unknown Agent '${agentId}'`);
    }
  }

  async mcpStatus() {
    return discoverMcpServers(this.config.mcpServers, this.projectDir);
  }

  async status() {
    return Promise.all([...this.agents.values()].map(async (agent) => ({
      ...agent,
      stages: (Object.entries(this.config.stages) as Array<[AgentRole, string[]]>).flatMap(([stage, ids]) => ids.includes(agent.id) ? [stage] : []),
      available: agent.enabled && await this.backends.get(agent.id)!.available(),
      capabilities: this.backends.get(agent.id)!.capabilities(),
    })));
  }

  async models(): Promise<AgentModelDiscovery[]> {
    return Promise.all([...this.agents.values()].map(async (agent) => {
      const backend = this.backends.get(agent.id)!;
      if (backend instanceof CliAgentBackend) {
        const discovery = await backend.discoverModels();
        return { ...discovery, agentId: agent.id };
      }
      const available = await backend.available();
      return {
        agentId: agent.id,
        available,
        models: agent.model ? [{ id: agent.model, label: agent.model }] : [],
        ...(agent.model ? { defaultModel: agent.model } : {}),
        source: available ? "configured" as const : "unavailable" as const,
      };
    }));
  }

  capabilityAgents() {
    return [...this.agents.values()].filter((agent) => agent.enabled).map((agent) => ({
      id: agent.id,
      backend: describeBackend(agent),
      capabilities: this.backends.get(agent.id)!.capabilities(),
    }));
  }

  async complete(
    role: AgentRole,
    call: Omit<AgentCall, "role" | "model">,
    selection: AgentSelection = {},
  ): Promise<AgentResponse> {
    const excluded = new Set(selection.exclude ?? []);
    const candidates = (selection.preferred ? [selection.preferred] : (this.config.stages[role] ?? [])).filter((id) => !excluded.has(id));
    const errors: string[] = [];
    // fallback 只发生在同一角色的显式候选列表中；取消和人工权限等待不能被当成普通失败跳过。
    for (const id of candidates) {
      const agent = this.agents.get(id);
      if (!agent?.enabled) continue;
      const backend = this.backends.get(id)!;
      const backendName = describeBackend(agent);
      if (call.images?.length && !backend.capabilities().imageInput) {
        errors.push(`${id}: skipped because this Agent does not support image input`);
        continue;
      }
      try {
        const activity = { agentId: agent.id, backend: backendName, ...(agent.model ? { model: agent.model } : {}) };
        await call.onActivity?.({ kind: "agent_started", ...activity });
        const contextPrompt = call.context
          ? backend.kind === "cli"
            ? `First read the RunHarness context file at ${call.context.filePath}. Inspect repository files and command output directly.\n\n${call.prompt}`
            : `Use this bounded RunHarness context summary. Inspect the repository with available tools when possible.\n\n${bound(call.context.summary, await this.agentContextBudget(agent, backend))}\n\n${call.prompt}`
          : call.prompt;
        const providerSessionId = call.conversation?.persist
          ? await this.conversations.get(call.conversation.runHarnessSessionId, agent.id, role)
          : undefined;
        const response = await backend.complete({
          ...call,
          onActivity: async (item) => call.onActivity?.(item.execution || !["tool_call", "tool_result"].includes(item.kind) ? item : {
            ...item,
            execution: { owner: "provider", placement: backend.kind === "cli" ? "provider_sandbox" : "unknown", controlled: false },
          }),
          prompt: contextPrompt,
          role,
          ...((this.config.mcpServers || call.mcpServers) ? { mcpServers: { ...this.config.mcpServers, ...call.mcpServers } } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          options: { ...agent.options, ...call.options },
          ...(call.conversation ? { conversation: { ...call.conversation, ...(providerSessionId ? { providerSessionId } : {}) } } : {}),
        });
        const nextProviderSessionId = typeof response.metadata.providerSessionId === "string" ? response.metadata.providerSessionId : undefined;
        if (call.conversation?.persist && nextProviderSessionId)
          await this.conversations.set(call.conversation.runHarnessSessionId, agent.id, role, nextProviderSessionId);
        await call.onActivity?.({ kind: "agent_completed", ...activity, durationMs: response.durationMs, success: true });
        return { ...response, backend: agent.id, metadata: { ...response.metadata, agentId: agent.id, transport: backendName } };
      } catch (error) {
        if (call.signal?.aborted || isAbortError(error)) throw error;
        if (error instanceof PermissionRequiredError) throw error;
        const summary = error instanceof Error ? error.message : String(error);
        await call.onActivity?.({ kind: "agent_failed", agentId: agent.id, backend: backendName, ...(agent.model ? { model: agent.model } : {}), summary, success: false });
        errors.push(`${id}: ${summary}`);
      }
    }
    throw new Error(`No ${role} Agent succeeded. ${errors.join(" | ") || "No Agent assigned."}`);
  }

  async completeMany(role: AgentRole, call: Omit<AgentCall, "role" | "model">): Promise<AgentResponse[]> {
    const ids = (this.config.stages[role] ?? []).filter((id) => this.agents.get(id)?.enabled);
    return Promise.all(ids.map((id) => this.complete(role, call, { preferred: id })));
  }

  async completeAgent(agentId: string, role: string, call: Omit<AgentCall, "role" | "model">): Promise<AgentResponse> {
    const agent = this.agents.get(agentId);
    if (!agent?.enabled) throw new Error(`Safety classifier Agent '${agentId}' is missing or disabled`);
    const backend = this.backends.get(agentId)!;
    if (call.images?.length && !backend.capabilities().imageInput) throw new Error(`Agent '${agentId}' does not support image input`);
    const backendName = describeBackend(agent);
    const activity = { agentId: agent.id, backend: backendName, ...(agent.model ? { model: agent.model } : {}) };
    await call.onActivity?.({ kind: "agent_started", ...activity });
    try {
      const contextPrompt = call.context
        ? backend.kind === "cli"
          ? `First read the RunHarness context file at ${call.context.filePath}.\n\n${call.prompt}`
          : `${bound(call.context.summary, await this.agentContextBudget(agent, backend))}\n\n${call.prompt}`
        : call.prompt;
      const response = await backend.complete({ ...call, onActivity: async (item) => call.onActivity?.(item.execution || !["tool_call", "tool_result"].includes(item.kind) ? item : { ...item, execution: { owner: "provider", placement: backend.kind === "cli" ? "provider_sandbox" : "unknown", controlled: false } }), prompt: contextPrompt, role, ...((this.config.mcpServers || call.mcpServers) ? { mcpServers: role === "safety_classifier" ? withControlMcp(call.mcpServers, "safety") : { ...this.config.mcpServers, ...call.mcpServers } } : {}), ...(agent.model ? { model: agent.model } : {}), options: { ...agent.options, ...call.options } });
      await call.onActivity?.({ kind: "agent_completed", ...activity, durationMs: response.durationMs, success: true });
      return { ...response, backend: agent.id, metadata: { ...response.metadata, agentId: agent.id, transport: backendName } };
    } catch (error) {
      if (call.signal?.aborted || isAbortError(error)) throw error;
      const summary = error instanceof Error ? error.message : String(error);
      await call.onActivity?.({ kind: "agent_failed", ...activity, summary, success: false });
      throw error;
    }
  }

  async contextBudgetChars(role: AgentRole): Promise<number> {
    const ids = (this.config.stages[role] ?? []).filter((id) => this.agents.get(id)?.enabled);
    const budgets = await Promise.all(ids.map(async (id) => {
      const agent = this.agents.get(id)!;
      const configured = typeof agent.options?.contextWindowTokens === "number" ? agent.options.contextWindowTokens : undefined;
      if (configured) return configured;
      const backend = this.backends.get(id)!;
      if (!(backend instanceof CliAgentBackend)) return 32_000;
      const discovery = await backend.discoverModels();
      const selected = agent.model ?? discovery.defaultModel;
      return discovery.models.find((model) => model.id === selected)?.contextWindowTokens ?? 32_000;
    }));
    const tokens = budgets[0] ?? 32_000;
    return Math.max(4_000, Math.min(32_000, Math.floor(tokens * 0.2 * 2)));
  }

  private async agentContextBudget(agent: AgentDefinition, backend: AgentBackend): Promise<number> {
    const configured = typeof agent.options?.contextWindowTokens === "number" ? agent.options.contextWindowTokens : undefined;
    if (configured) return Math.max(4_000, Math.min(32_000, Math.floor(configured * 0.2 * 2)));
    if (!(backend instanceof CliAgentBackend)) return 12_000;
    const discovery = await backend.discoverModels();
    const selected = agent.model ?? discovery.defaultModel;
    const tokens = discovery.models.find((model) => model.id === selected)?.contextWindowTokens ?? 32_000;
    return Math.max(4_000, Math.min(32_000, Math.floor(tokens * 0.2 * 2)));
  }
}

function describeBackend(agent: AgentDefinition) {
  return agent.backend.type === "cli" ? agent.backend.command : agent.backend.protocol;
}

function bound(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}\n… context truncated; use referenced evidence tools …` : value; }
