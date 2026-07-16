import { useEffect, useState } from "react";
import type { AgentDefinition, AgentModelDiscovery, AgentRole, AgentStatus, BuiltinPermissionCatalogEntry, CapabilitySnapshot, McpServerStatus, ModelRoutingConfig, PermissionRule, PromptSlot, RuntimeSettings } from "@runharness/shared";
import { useI18n } from "../i18n/provider";
import type { SettingsSection } from "../routes";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardArticle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";

export function SettingsPage({ section, configText, configPath, configDirty, agents, models, mcpServers, capabilities, runtime, runtimeDirty, permissionCatalog, prompts, onSection, onConfigText, onSaveConfig, onDiscardConfig, onUpdateAgents, onAssignAgent, onToggleMcp, onRuntime, onSaveRuntime, onDiscardRuntime, onRefresh }: {
  section: SettingsSection; configText: string; configPath: string; configDirty: boolean; agents: AgentStatus[]; models: AgentModelDiscovery[]; mcpServers: McpServerStatus[]; capabilities: CapabilitySnapshot; runtime: RuntimeSettings; runtimeDirty: boolean; permissionCatalog: BuiltinPermissionCatalogEntry[]; prompts: PromptSlot[];
  onSection(section: SettingsSection): void; onConfigText(value: string): void; onSaveConfig(): Promise<void>; onDiscardConfig(): void; onUpdateAgents(config: ModelRoutingConfig): void; onAssignAgent(stage: AgentRole, agentId: string, assigned: boolean): void; onToggleMcp(name: string, enabled: boolean): void; onRuntime(value: RuntimeSettings): void; onSaveRuntime(): Promise<void>; onDiscardRuntime(): void; onRefresh(): Promise<void>;
}) {
  const { t } = useI18n();
  return <div className="settings-page"><Tabs value={section} onValueChange={(value) => onSection(value as SettingsSection)}><TabsList className="subnav">{(["agents", "tools", "runtime", "prompts"] as const).map((item) => <TabsTrigger key={item} value={item}>{t(`settings.tabs.${item}`)}</TabsTrigger>)}</TabsList></Tabs>
    {(section === "agents" || section === "tools") && <DraftActions dirty={configDirty} onSave={onSaveConfig} onDiscard={onDiscardConfig} />}
    {section === "agents" && <Agents configText={configText} configPath={configPath} statuses={agents} models={models} onConfigText={onConfigText} onSave={onSaveConfig} onUpdate={onUpdateAgents} onAssign={onAssignAgent} />}
    {section === "tools" && <Tools configText={configText} configPath={configPath} statuses={mcpServers} capabilities={capabilities} onToggle={onToggleMcp} />}
    {section === "runtime" && <Runtime runtime={runtime} dirty={runtimeDirty} agents={agents} permissionCatalog={permissionCatalog} onRuntime={onRuntime} onSave={onSaveRuntime} onDiscard={onDiscardRuntime} />}
    {section === "prompts" && <Prompts prompts={prompts} onRefresh={onRefresh} />}
  </div>;
}

function Tools({ configText, configPath, statuses, capabilities, onToggle }: { configText: string; configPath: string; statuses: McpServerStatus[]; capabilities: CapabilitySnapshot; onToggle(name: string, enabled: boolean): void }) {
  const { t } = useI18n();
  let config: ModelRoutingConfig | undefined;
  try { config = JSON.parse(configText) as ModelRoutingConfig; } catch { /* 保存时由模型配置编辑器展示 JSON 错误。 */ }
  const servers = Object.entries(config?.mcpServers ?? {});
  return <Card className="panel"><header className="panelhead"><h2>{t("settings.tools.title")}</h2><p>{t("settings.tools.note")}</p><code>{configPath}</code></header>
    <section className="runtime-capabilities"><h3>{t("settings.tools.runtimes")}</h3><p>{t("settings.tools.runtimesHint")}</p><div className="mcp-cards">{capabilities.runtimes.map((runtime) => <CardArticle key={runtime.id}><header><div><Badge>{runtime.owner}</Badge><Badge>{runtime.placement}</Badge><strong>{runtime.label}</strong></div></header><p>{runtime.detail}</p><code>{runtime.capabilities.join(" · ")}</code><small>{runtime.controlled ? t("settings.tools.controlled") : t("settings.tools.observed")}</small>{runtime.limitations.map((limitation) => <p className="field-error" key={limitation}>{limitation}</p>)}</CardArticle>)}</div></section>
    <section className="runtime-capabilities"><h3>{t("settings.tools.providerCapabilities")}</h3><p>{t("settings.tools.providerCapabilitiesHint")}</p><div className="tool-tags">{capabilities.agents.map((agent) => <span key={agent.id}>{agent.id} · {agent.backend} · {Object.entries(agent.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ")}</span>)}</div></section>
    <section className="runtime-capabilities"><h3>{t("settings.tools.acceptance")}</h3><p>{capabilities.acceptance.length ? t("settings.tools.acceptanceCount", { count: capabilities.acceptance.length }) : t("settings.tools.acceptanceEmpty")}</p></section>
    {servers.length === 0 ? <div className="empty-state"><strong>{t("settings.tools.empty")}</strong><span>{t("settings.tools.emptyHint")}</span><code>{'"mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "enabled": true } }'}</code></div> :
      <div className="mcp-cards">{servers.map(([name, server]) => { const status = statuses.find((item) => item.name === name); const enabled = server.enabled !== false; return <CardArticle key={name}>
        <header><div><Badge className={enabled && status?.available ? "online" : "offline"}>{!enabled ? t("settings.tools.disabled") : status?.available ? t("common.ready") : t("common.offline")}</Badge><Badge>{t("settings.tools.inheritsPolicy")}</Badge><strong>{name}</strong></div><Switch aria-label={t("settings.tools.toggle", { name })} checked={enabled} onCheckedChange={(checked) => void onToggle(name, checked)} /></header>
        <code>{typeof server.command === "string" ? [server.command, ...(server.args ?? [])].join(" ") : server.url}</code>
        <p>{t("settings.tools.inheritsPolicyHint")}</p>
        <p>{status?.available ? t("settings.tools.toolCount", { count: status.tools.length }) : status?.error ?? t("settings.tools.notChecked")}</p>
        {status?.unknownDisabledTools?.length ? <p className="field-error">{t("settings.tools.unknownDisabledTools", { tools: status.unknownDisabledTools.join(", ") })}</p> : null}
        {status?.tools.length ? <div className="tool-tags">{status.tools.map((tool) => <span key={tool.name}>{tool.name}</span>)}</div> : null}
      </CardArticle>; })}</div>}
  </Card>;
}

function Agents({ configText, configPath, statuses, models, onConfigText, onSave, onUpdate, onAssign }: { configText: string; configPath: string; statuses: AgentStatus[]; models: AgentModelDiscovery[]; onConfigText(value: string): void; onSave(): Promise<void>; onUpdate(config: ModelRoutingConfig): void; onAssign(stage: AgentRole, agentId: string, assigned: boolean): void }) {
  const { t } = useI18n();
  const [newId, setNewId] = useState("");
  const [newType, setNewType] = useState<"cli" | "api">("cli");
  const [message, setMessage] = useState("");
  let config: ModelRoutingConfig | undefined;
  try { config = JSON.parse(configText) as ModelRoutingConfig; } catch { /* JSON 编辑器负责展示格式错误。 */ }
  async function addAgent() {
    if (!config) return;
    const id = newId.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { setMessage(t("settings.agents.invalidId")); return; }
    if (config.agents.some((agent) => agent.id === id)) { setMessage(t("settings.agents.duplicate")); return; }
    const backend = newType === "cli" ? { type: "cli" as const, command: id, timeoutMs: 600_000 } : { type: "api" as const, protocol: "openai-compatible" as const, apiKeyEnv: "API_KEY" };
    onUpdate({ ...config, agents: [...config.agents, { id, enabled: true, backend }] });
    setNewId(""); setMessage("");
  }
  return <div className="agent-settings">
    <Card className="panel"><header className="panelhead"><h2>{t("settings.agents.title")}</h2><p>{t("settings.agents.note")}</p><code>{configPath}</code></header>
      <div className="add-agent"><Input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder={t("settings.agents.idPlaceholder")} /><Choice value={newType} onValue={(value) => setNewType(value as "cli" | "api")} options={[{ value: "cli", label: "CLI" }, { value: "api", label: "API" }]} /><Button onClick={() => void addAgent()}>{t("settings.agents.add")}</Button></div>
      {message && <p className="action-message">{message}</p>}
      <div className="agent-editor-list">{config?.agents.map((agent) => <AgentEditor key={agent.id} agent={agent} config={config!} status={statuses.find((item) => item.id === agent.id)} discovery={models.find((item) => item.agentId === agent.id)} onUpdate={onUpdate} />)}</div>
      <Collapsible className="config-editor"><CollapsibleTrigger>{t("settings.agents.advanced")}</CollapsibleTrigger><CollapsibleContent><Textarea value={configText} onChange={(event) => onConfigText(event.target.value)} /><Button onClick={() => void onSave()}>{t("settings.agents.save")}</Button></CollapsibleContent></Collapsible>
    </Card>
    <Card className="panel"><header className="panelhead"><h2>{t("settings.agents.stagesTitle")}</h2><p>{t("settings.agents.stagesNote")}</p></header>
      {config && <div className="stage-assignments">
        {(["planner", "generator"] as const).map((stage) => <OrderedRouting key={stage} stage={stage} config={config} onUpdate={onUpdate} />)}
        <EvaluatorRouting config={config} onAssign={onAssign} />
      </div>}
    </Card>
  </div>;
}

function OrderedRouting({ stage, config, onUpdate }: { stage: "planner" | "generator"; config: ModelRoutingConfig; onUpdate(config: ModelRoutingConfig): void }) {
  const { t } = useI18n();
  const route = config.stages[stage];
  const primary = route[0] ?? config.agents[0]?.id ?? "";
  const fallbacks = route.slice(1);
  const available = config.agents.filter((agent) => !route.includes(agent.id));
  const setRoute = (ids: string[]) => onUpdate({ ...config, stages: { ...config.stages, [stage]: ids } });
  const setPrimary = (agentId: string) => setRoute([agentId, ...route.filter((id) => id !== agentId)]);
  const move = (index: number, direction: -1 | 1) => {
    const next = [...fallbacks]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setRoute([primary, ...next]);
  };
  return <CardArticle className="ordered-routing"><header><strong>{stage}</strong><Badge>{route.length}</Badge></header>
    <label className="routing-primary"><span>{t("settings.agents.primary")}</span><Choice value={primary} onValue={setPrimary} options={config.agents.map((agent) => ({ value: agent.id, label: agent.id }))} /></label>
    <div className="fallback-list"><b>{t("settings.agents.fallbacks")}</b>{fallbacks.length === 0 && <small>{t("settings.agents.noFallback")}</small>}{fallbacks.map((agentId, index) => <div key={agentId}><span>{index + 1}. {agentId}</span><div><Button variant="ghost" size="sm" disabled={index === 0} aria-label={t("settings.agents.moveUp", { agent: agentId })} onClick={() => move(index, -1)}>↑</Button><Button variant="ghost" size="sm" disabled={index === fallbacks.length - 1} aria-label={t("settings.agents.moveDown", { agent: agentId })} onClick={() => move(index, 1)}>↓</Button><Button variant="ghost" size="sm" onClick={() => setRoute([primary, ...fallbacks.filter((id) => id !== agentId)])}>{t("settings.agents.removeFallback")}</Button></div></div>)}</div>
    {available.length > 0 && <label className="routing-add"><span>{t("settings.agents.addFallback")}</span><Choice value="__choose__" onValue={(agentId) => { if (agentId !== "__choose__") setRoute([primary, ...fallbacks, agentId]); }} options={[{ value: "__choose__", label: t("settings.agents.chooseAgent") }, ...available.map((agent) => ({ value: agent.id, label: agent.id }))]} /></label>}
  </CardArticle>;
}

function EvaluatorRouting({ config, onAssign }: { config: ModelRoutingConfig; onAssign(stage: AgentRole, agentId: string, assigned: boolean): void }) {
  const { t } = useI18n(); const route = config.stages.evaluator;
  return <CardArticle className="evaluator-routing"><header><strong>evaluator</strong><Badge>{route.length}</Badge></header><p>{t("settings.agents.reviewersHint")}</p>{config.agents.map((agent) => { const checked = route.includes(agent.id); const requiredLast = checked && route.length === 1; return <label key={agent.id}><Checkbox checked={checked} disabled={requiredLast} onCheckedChange={(value) => onAssign("evaluator", agent.id, value === true)} /><span>{agent.id}</span></label>; })}</CardArticle>;
}

function AgentEditor({ agent, config, status, discovery, onUpdate }: { agent: AgentDefinition; config: ModelRoutingConfig; status: AgentStatus | undefined; discovery: AgentModelDiscovery | undefined; onUpdate(config: ModelRoutingConfig): void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(agent);
  const [envText, setEnvText] = useState(agent.backend.type === "cli" ? JSON.stringify(agent.backend.env ?? {}, null, 2) : "");
  const [envError, setEnvError] = useState("");
  const agentSnapshot = JSON.stringify(agent);
  useEffect(() => { const source = JSON.parse(agentSnapshot) as AgentDefinition; setDraft(source); setEnvText(source.backend.type === "cli" ? JSON.stringify(source.backend.env ?? {}, null, 2) : ""); }, [agentSnapshot]);
  const commit = (next: AgentDefinition) => { setDraft(next); onUpdate({ ...config, agents: config.agents.map((item) => item.id === agent.id ? next : item) }); };
  const requiredStages = (["planner", "generator", "evaluator"] as AgentRole[]).filter((stage) => config.stages[stage].length === 1 && config.stages[stage][0] === agent.id);
  async function remove() {
    if (requiredStages.length) return;
    onUpdate({ ...config, agents: config.agents.filter((item) => item.id !== agent.id), stages: Object.fromEntries(Object.entries(config.stages).map(([stage, ids]) => [stage, ids.filter((id) => id !== agent.id)])) as ModelRoutingConfig["stages"] });
  }
  function updateModel(value: string) {
    if (value) commit({ ...draft, model: value });
    else { const withoutModel = { ...draft }; delete withoutModel.model; commit(withoutModel); }
  }
  function updateCli(patch: Partial<Extract<AgentDefinition["backend"], { type: "cli" }>>) {
    if (draft.backend.type === "cli") commit({ ...draft, backend: { ...draft.backend, ...patch } });
  }
  function updateApi(patch: Partial<Extract<AgentDefinition["backend"], { type: "api" }>>) {
    if (draft.backend.type === "api") commit({ ...draft, backend: { ...draft.backend, ...patch } });
  }
  function updateBaseUrl(value: string) {
    if (draft.backend.type !== "api") return;
    if (value) updateApi({ baseUrl: value });
    else { const withoutBaseUrl = { ...draft.backend }; delete withoutBaseUrl.baseUrl; commit({ ...draft, backend: withoutBaseUrl }); }
  }
  function commitEnv() {
    if (draft.backend.type !== "cli") return;
    try { const env = JSON.parse(envText || "{}") as Record<string, string>; if (Object.values(env).some((value) => typeof value !== "string")) throw new Error(t("settings.agents.envInvalid")); setEnvError(""); commit({ ...draft, backend: { ...draft.backend, env } }); }
    catch (caught) { setEnvError(caught instanceof Error ? caught.message : String(caught)); }
  }
  return <CardArticle className="agent-editor"><header><div><Badge className={status?.available ? "online" : "offline"}>{status?.available ? t("common.ready") : t("common.offline")}</Badge><strong>{agent.id}</strong><small>{status?.stages.join(" · ") || t("settings.agents.unassigned")}</small></div><label><span>{t("settings.agents.enabled")}</span><Switch checked={draft.enabled} onCheckedChange={(checked) => commit({ ...draft, enabled: checked })} /></label></header>
    <div className="agent-fields"><label><span>{t("settings.agents.model")}</span><Input value={draft.model ?? ""} placeholder={discovery?.defaultModel ?? t("settings.agents.defaultModel")} onChange={(event) => updateModel(event.target.value)} /></label>
      {draft.backend.type === "cli" ? <><label><span>{t("settings.agents.command")}</span><Input value={draft.backend.command} onChange={(event) => updateCli({ command: event.target.value })} /></label><label className="wide"><span>{t("settings.agents.args")}</span><Input value={(draft.backend.args ?? []).join(" ")} onChange={(event) => updateCli({ args: event.target.value.trim() ? event.target.value.split(/\s+/) : [] })} /></label><label className="wide"><span>{t("settings.agents.env")}</span><Textarea value={envText} onChange={(event) => setEnvText(event.target.value)} onBlur={commitEnv} />{envError && <small className="field-error">{envError}</small>}</label></> : <><label><span>{t("settings.agents.protocol")}</span><Choice value={draft.backend.protocol} onValue={(value) => updateApi({ protocol: value as "anthropic" | "openai-compatible" })} options={[{ value: "anthropic", label: "Anthropic" }, { value: "openai-compatible", label: "OpenAI compatible" }]} /></label><label><span>{t("settings.agents.baseUrl")}</span><Input value={draft.backend.baseUrl ?? ""} onChange={(event) => updateBaseUrl(event.target.value)} /></label><label><span>{t("settings.agents.apiKeyEnv")}</span><Input value={draft.backend.apiKeyEnv} onChange={(event) => updateApi({ apiKeyEnv: event.target.value })} /></label><small className="wide">{t("settings.agents.apiToolsHint")}</small></>}
    </div><footer><span>{t("settings.agents.draftApplied")} · {discovery?.models.length ?? 0} {t("settings.agents.discovered")}</span><div><Button variant="secondary" disabled={Boolean(requiredStages.length)} title={requiredStages.join(", ")} onClick={() => void remove()}>{t("settings.agents.remove")}</Button></div></footer>
  </CardArticle>;
}

function Runtime({ runtime, dirty, agents, permissionCatalog, onRuntime, onSave, onDiscard }: { runtime: RuntimeSettings; dirty: boolean; agents: AgentStatus[]; permissionCatalog: BuiltinPermissionCatalogEntry[]; onRuntime(value: RuntimeSettings): void; onSave(): Promise<void>; onDiscard(): void }) {
  const { t } = useI18n();
  const updatePolicy = (patch: Partial<RuntimeSettings["executionPolicy"]>) => onRuntime({ ...runtime, executionPolicy: { ...runtime.executionPolicy, ...patch } });
  const updateRules = (customRules: PermissionRule[]) => updatePolicy({ customRules });
  const addRule = () => updateRules([...runtime.executionPolicy.customRules, { id: `rule_${crypto.randomUUID().slice(0, 8)}`, scope: "command", pattern: "", decision: "deny" }]);
  const updateRule = (index: number, patch: Partial<PermissionRule>) => updateRules(runtime.executionPolicy.customRules.map((rule, current) => current === index ? { ...rule, ...patch } : rule));
  return <Card className="panel"><header className="panelhead"><h2>{t("settings.runtime.title")}</h2><p>{t("settings.runtime.note")}</p></header>
    <label className="iteration-setting"><span><b>{t("settings.runtime.iterations")}</b><small>{t("settings.runtime.iterationsHint")}</small></span><Choice value={String(runtime.maxIterations)} onValue={(value) => onRuntime({ ...runtime, maxIterations: Number(value) })} options={Array.from({ length: 20 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} /></label>
    <div className="toggle-list">
      <label><span><b>{t("settings.runtime.planReview")}</b><small>{t("settings.runtime.planReviewHint")}</small></span><Choice value={runtime.planReview} onValue={(value) => onRuntime({ ...runtime, planReview: value as RuntimeSettings["planReview"] })} options={[{ value: "auto", label: t("settings.runtime.planAuto") }, { value: "require_approval", label: t("settings.runtime.planManual") }]} /></label>
      <label><span><b>{t("settings.runtime.workspacePlacement")}</b><small>{t("settings.runtime.workspacePlacementHint")}</small></span><Choice value={runtime.executionPolicy.workspace.placement} onValue={(placement) => updatePolicy({ workspace: { ...runtime.executionPolicy.workspace, placement: placement as RuntimeSettings["executionPolicy"]["workspace"]["placement"] } })} options={[{ value: "in_place", label: t("settings.runtime.inPlace") }, { value: "isolated", label: t("settings.runtime.isolated") }]} /></label>
      <label><span><b>{t("settings.runtime.workspaceAccess")}</b><small>{t("settings.runtime.workspaceAccessHint")}</small></span><Choice value={runtime.executionPolicy.workspace.access} onValue={(access) => updatePolicy({ workspace: { ...runtime.executionPolicy.workspace, access: access as RuntimeSettings["executionPolicy"]["workspace"]["access"] } })} options={[{ value: "read_write", label: t("settings.runtime.readWrite") }, { value: "read_only", label: t("settings.runtime.readOnly") }]} /></label>
      <label><span><b>{t("settings.runtime.materializeIgnored")}</b><small>{t("settings.runtime.materializeIgnoredHint")}</small></span><Textarea value={runtime.executionPolicy.workspace.materializeIgnored.join("\n")} placeholder={t("settings.runtime.materializeIgnoredPlaceholder")} onChange={(event) => updatePolicy({ workspace: { ...runtime.executionPolicy.workspace, materializeIgnored: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) } })} /></label>
      <label><span><b>{t("settings.runtime.network")}</b><small>{t("settings.runtime.networkHint")}</small></span><Choice value={runtime.executionPolicy.network} onValue={(value) => updatePolicy({ network: value as RuntimeSettings["executionPolicy"]["network"] })} options={[{ value: "deny", label: t("settings.runtime.networkDeny") }, { value: "allow_declared", label: t("settings.runtime.networkDeclared") }, { value: "allow_all", label: t("settings.runtime.networkAll") }]} /></label>
      <label><span><b>{t("settings.runtime.permissionMode")}</b><small>{t("settings.runtime.permissionModeHint")}</small></span><Choice value={runtime.executionPolicy.approvalMode} onValue={(value) => updatePolicy({ approvalMode: value as RuntimeSettings["executionPolicy"]["approvalMode"] })} options={[{ value: "allow_all", label: t("settings.runtime.allowAll") }, { value: "dangerous_only", label: t("settings.runtime.dangerousOnly") }]} /></label>
      <label><span><b>{t("settings.runtime.safetyClassifier")}</b><small>{t("settings.runtime.safetyClassifierHint")}</small></span><Switch checked={runtime.safetyClassifier.enabled} onCheckedChange={(enabled) => onRuntime({ ...runtime, safetyClassifier: { ...runtime.safetyClassifier, enabled } })} /></label>
      {runtime.safetyClassifier.enabled && <label><span><b>{t("settings.runtime.safetyAgent")}</b><small>{t("settings.runtime.safetyAgentHint")}</small></span><Choice value={runtime.safetyClassifier.agentId ?? ""} onValue={(agentId) => onRuntime({ ...runtime, safetyClassifier: { ...runtime.safetyClassifier, agentId } })} options={agents.map((agent) => ({ value: agent.id, label: agent.id }))} /></label>}
      {runtime.safetyClassifier.enabled && <label><span><b>{t("settings.runtime.classifierFallback")}</b><small>{t("settings.runtime.classifierFallbackHint")}</small></span><Choice value={runtime.safetyClassifier.fallback} onValue={(fallback) => onRuntime({ ...runtime, safetyClassifier: { ...runtime.safetyClassifier, fallback: fallback as RuntimeSettings["safetyClassifier"]["fallback"] } })} options={[{ value: "use_base_policy", label: t("settings.runtime.useBasePolicy") }, { value: "ask", label: t("settings.runtime.askOnFailure") }]} /></label>}
    </div>
    <section className="effective-policy"><h3>{t("settings.runtime.effectivePolicy")}</h3><dl><div><dt>{t("settings.runtime.workspace")}</dt><dd>{t(`settings.runtime.effectiveWorkspace.${runtime.executionPolicy.workspace.placement}_${runtime.executionPolicy.workspace.access}`)}</dd></div><div><dt>{t("settings.runtime.network")}</dt><dd>{t(`settings.runtime.effectiveNetwork.${runtime.executionPolicy.network}`)}</dd></div><div><dt>{t("settings.runtime.permissionMode")}</dt><dd>{t(`settings.runtime.effectiveApproval.${runtime.executionPolicy.approvalMode}`)}</dd></div><div><dt>{t("settings.runtime.rules")}</dt><dd>{t("settings.runtime.effectiveRules", { count: runtime.executionPolicy.customRules.length })}</dd></div><div><dt>{t("settings.runtime.providerLayer")}</dt><dd>{t("settings.runtime.providerLayerHint")}</dd></div></dl></section>
    <section className="permission-catalog"><header><div><h3>{t("settings.runtime.catalogTitle")}</h3><p>{t("settings.runtime.catalogHint")}</p></div><Badge>{t(runtime.executionPolicy.approvalMode === "dangerous_only" ? "settings.runtime.catalogActive" : "settings.runtime.catalogInactive")}</Badge></header><div>{permissionCatalog.map((entry) => <article key={entry.id}><Badge>{t(`settings.runtime.ruleDecision.${entry.decision}`)}</Badge><div><b>{t(`settings.runtime.catalog.${entry.id}.title`)}</b><p>{t(`settings.runtime.catalog.${entry.id}.description`)}</p><code>{entry.examples.join(" · ")}</code></div></article>)}</div><small>{t("settings.runtime.catalogReadOnly")}</small></section>
    <section className="policy-chain"><h3>{t("settings.runtime.policyChain")}</h3><div><span>1</span><p><b>{t("settings.runtime.rulesLayer")}</b><small>{t("settings.runtime.rulesLayerHint")}</small></p></div><div><span>2</span><p><b>{t("settings.runtime.builtinLayer")}</b><small>{t("settings.runtime.builtinLayerHint")}</small></p></div><div><span>3</span><p><b>{t("settings.runtime.classifierLayer")}</b><small>{runtime.safetyClassifier.enabled ? t("settings.runtime.classifierOn") : t("settings.runtime.classifierOff")}</small></p></div></section>
    <section className="permission-rules"><header><div><h3>{t("settings.runtime.rules")}</h3><p>{t("settings.runtime.rulesHint")}</p></div><Button variant="secondary" onClick={addRule}>{t("settings.runtime.addRule")}</Button></header>{runtime.executionPolicy.customRules.length === 0 && <p className="empty-rule">{t("settings.runtime.noRules")}</p>}{runtime.executionPolicy.customRules.map((rule, index) => <div className="permission-rule" key={rule.id}><Choice value={rule.scope} onValue={(scope) => updateRule(index, { scope: scope as PermissionRule["scope"] })} options={(["command", "path", "origin", "mcp_tool", "action"] as const).map((scope) => ({ value: scope, label: t(`settings.runtime.ruleScope.${scope}`) }))} /><Input value={rule.pattern} placeholder={t("settings.runtime.rulePattern")} onChange={(event) => updateRule(index, { pattern: event.target.value })} /><Choice value={rule.decision} onValue={(decision) => updateRule(index, { decision: decision as PermissionRule["decision"] })} options={(["allow", "ask", "deny"] as const).map((decision) => ({ value: decision, label: t(`settings.runtime.ruleDecision.${decision}`) }))} /><Button variant="ghost" onClick={() => updateRules(runtime.executionPolicy.customRules.filter((_, current) => current !== index))}>{t("settings.runtime.removeRule")}</Button></div>)}</section>
    <div className="editor-actions"><span>v{runtime.revision} · {dirty ? t("settings.draft.unsaved") : t("settings.draft.saved")}</span><div><Button variant="secondary" disabled={!dirty} onClick={onDiscard}>{t("settings.draft.discard")}</Button><Button disabled={!dirty} onClick={() => void onSave()}>{t("settings.runtime.save")}</Button></div></div>
  </Card>;
}

function DraftActions({ dirty, onSave, onDiscard }: { dirty: boolean; onSave(): Promise<void>; onDiscard(): void }) {
  const { t } = useI18n();
  return <div className="settings-savebar" role="status"><span>{dirty ? t("settings.draft.unsavedHint") : t("settings.draft.savedHint")}</span><div><Button variant="secondary" disabled={!dirty} onClick={onDiscard}>{t("settings.draft.discard")}</Button><Button disabled={!dirty} onClick={() => void onSave()}>{t("settings.draft.save")}</Button></div></div>;
}

function Choice({ value, onValue, options }: { value: string; onValue(value: string): void; options: Array<{ value: string; label: string }> }) {
  return <Select value={value} onValueChange={onValue}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}

function Prompts({ prompts, onRefresh }: { prompts: PromptSlot[]; onRefresh(): Promise<void> }) {
  const { t } = useI18n(); const [selected, setSelected] = useState(""); const slot = prompts.find((item) => item.key === selected) ?? prompts[0]; const [text, setText] = useState(""); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  const savedText = slot?.history.find((item) => item.version === slot.currentVersion)?.content ?? "";
  const dirty = Boolean(slot && text !== savedText);
  useEffect(() => { setText(savedText); setMessage(""); }, [savedText, slot?.currentVersion, slot?.key]);
  async function save() {
    if (!slot || !dirty || !text.trim()) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/prompts/${slot.key}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? t("common.saveFailed"));
      }
      setMessage(t("settings.prompts.saved"));
      await onRefresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }
  return <div className="prompt-layout"><Card className="panel prompt-catalog"><header className="panelhead"><h2>{t("settings.prompts.title")}</h2><p>{t("settings.prompts.note")}</p></header>
    {(["system", "user"] as const).map((scope) => <section className="slot-group" key={scope}><h3>{t(`settings.prompts.scope.${scope}`)}</h3><div className="slot-list">{prompts.filter((item) => item.scope === scope).map((item) => <Button variant="ghost" key={item.key} className={item.key === slot?.key ? "active" : ""} aria-pressed={item.key === slot?.key} onClick={() => setSelected(item.key)}><b>{item.key}</b><span><small>{t(`settings.prompts.channel.${item.scope === "system" ? "system_prompt" : "user_context"}`)}</small><small>v{item.currentVersion}</small></span></Button>)}</div></section>)}
  </Card>
    <Card className="panel prompt-editor"><header className="panelhead"><div className="prompt-title"><h2>{slot?.key ?? t("settings.prompts.empty")}</h2>{slot && <span>{t(`settings.prompts.scope.${slot.scope}`)} · v{slot.currentVersion}</span>}</div><p>{slot ? t(`settings.prompts.slots.${slot.key}`) : ""}</p></header>
      {slot && <section className="prompt-application"><header><h3>{t("settings.prompts.activationTitle")}</h3><p>{t("settings.prompts.activationHint")}</p></header><div className="prompt-role-tags">{slot.roles.map((role) => <span key={role}>{t(`settings.prompts.roles.${role}`)}</span>)}</div><ol>{slot.applications.map((application) => <li key={`${application.node}-${application.channel}`}><div><strong>{t(`settings.prompts.nodes.${application.node}.title`)}</strong><code>{t(`settings.prompts.nodes.${application.node}.callsite`)}</code></div><p>{t(`settings.prompts.nodes.${application.node}.detail`)}</p><small>{t("settings.prompts.injectedAs", { channel: t(`settings.prompts.channel.${application.channel}`) })}</small></li>)}</ol><p className="prompt-snapshot-note">{t("settings.prompts.snapshotNote")}</p>{slot.key === "safety_classifier_kernel" && <p className="prompt-safety-note">{t("settings.prompts.safetyNote")}</p>}</section>}
      <label className="prompt-content"><span>{t("settings.prompts.content")}</span><Textarea value={text} onChange={(event) => setText(event.target.value)} /></label><div className="editor-actions"><span>{dirty ? t("settings.prompts.unsaved") : t("settings.prompts.savedState")}</span><Button disabled={!dirty || !text.trim() || saving} onClick={() => void save()}>{saving ? t("settings.prompts.saving") : t("settings.prompts.save")}</Button></div>{message && <p className="action-message" role="status">{message}</p>}
    </Card></div>;
}
