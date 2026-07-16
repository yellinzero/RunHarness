import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { defaultRuntimeSettings } from "@runharness/shared";
import type { AgentModelDiscovery, AgentRole, BuiltinPermissionCatalogEntry, CapabilitySnapshot, DashboardSnapshot, DevelopmentRunResult, HarnessEvent, ImageAttachment, McpServerStatus, ModelRoutingConfig, RunRecord, RuntimeRegistration, RuntimeSettings } from "@runharness/shared";
import { useI18n } from "./i18n/provider";
import { fetchSessionEvents, readableRuntimeError } from "./api";
import { LearnPage } from "./pages/LearnPage";
import { parseRoute, routeForSession, routePath, type DashboardRoute, type LearnTopic, type RunTab, type SettingsSection } from "./routes";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Activity, BookOpenText, Languages, Radio, SlidersHorizontal } from "lucide-react";

const empty: DashboardSnapshot = { sessions: [], events: [], prompts: [], agents: [] };
const RunPage = lazy(async () => ({ default: (await import("./pages/RunPage")).RunPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./pages/SettingsPage")).SettingsPage }));

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [route, setRoute] = useState<DashboardRoute>(() => parseRoute(window.location.pathname, window.location.search));
  const [data, setData] = useState<DashboardSnapshot>(empty);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [developmentResult, setDevelopmentResult] = useState<DevelopmentRunResult>();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeRegistration[]>([]);
  const [currentRuntime, setCurrentRuntime] = useState<RuntimeRegistration>();
  const [configText, setConfigText] = useState("");
  const [savedConfigText, setSavedConfigText] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [models, setModels] = useState<AgentModelDiscovery[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshot>({ agents: [], runtimes: [], acceptance: [] });
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(() => structuredClone(defaultRuntimeSettings));
  const [savedRuntimeSettings, setSavedRuntimeSettings] = useState<RuntimeSettings>(() => structuredClone(defaultRuntimeSettings));
  const [permissionCatalog, setPermissionCatalog] = useState<BuiltinPermissionCatalogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const navigate = useCallback((next: DashboardRoute, replace = false) => {
    const path = routePath(next);
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [snapshotResponse, runtimesResponse] = await Promise.all([fetch("/api/snapshot"), fetch("/api/runtimes")]);
      if (!snapshotResponse.ok) throw new Error(t("common.snapshotFailed"));
      setData(await snapshotResponse.json() as DashboardSnapshot);
      if (runtimesResponse.ok) {
        const body = await runtimesResponse.json() as { current: RuntimeRegistration | null; runtimes: RuntimeRegistration[] };
        setRuntimes(body.runtimes); setCurrentRuntime(body.current ?? undefined);
      }
      setLoaded(true);
    } catch (caught) { setError(readableRuntimeError(caught, t("common.runtimeOffline"))); setLoaded(true); }
  }, [t]);

  const loadModels = useCallback(async () => {
    const response = await fetch("/api/models");
    if (response.ok) setModels((await response.json() as { agents: AgentModelDiscovery[] }).agents);
  }, []);

  const loadMcp = useCallback(async () => {
    const response = await fetch("/api/mcp");
    if (response.ok) setMcpServers((await response.json() as { servers: McpServerStatus[] }).servers);
  }, []);

  useEffect(() => {
    const pop = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500); return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (route.kind !== "settings") return;
    void Promise.all([
      fetch("/api/config").then(async (response) => { if (response.ok) { const body = await response.json() as { config: unknown; configPath: string }; const text = JSON.stringify(body.config, null, 2); setConfigText(text); setSavedConfigText(text); setConfigPath(body.configPath); } }),
      loadModels(),
      loadMcp(),
      fetch("/api/capabilities").then(async (response) => { if (response.ok) setCapabilities(await response.json() as CapabilitySnapshot); }),
      fetch("/api/runtime").then(async (response) => { if (response.ok) { const settings = await response.json() as RuntimeSettings; setRuntimeSettings(settings); setSavedRuntimeSettings(structuredClone(settings)); } }),
      fetch("/api/runtime/permission-catalog").then(async (response) => { if (response.ok) setPermissionCatalog((await response.json() as { entries: BuiltinPermissionCatalogEntry[] }).entries); }),
    ]).catch((caught: unknown) => setError(readableRuntimeError(caught, t("common.runtimeOffline"))));
  }, [loadMcp, loadModels, route.kind, t]);

  useEffect(() => {
    if (!loaded || route.kind !== "runs" || route.sessionId || !data.sessions[0]) return;
    navigate({ kind: "runs", sessionId: data.sessions[0].id, tab: "overview" }, true);
  }, [data.sessions, loaded, navigate, route]);

  const selectedSession = route.kind === "runs" ? data.sessions.find((session) => session.id === route.sessionId) : undefined;
  useEffect(() => {
    if (!selectedSession) { setEvents([]); setRuns([]); setAttachments([]); setDevelopmentResult(undefined); return; }
    let cancelled = false;
    let source: EventSource | undefined;
    setEvents([]); setRuns([]); setAttachments([]); setDevelopmentResult(undefined);
    const load = async () => {
      try {
        const [loadedEvents, detailResponse, attachmentResponse] = await Promise.all([fetchSessionEvents(selectedSession.id), fetch(`/api/sessions/${selectedSession.id}`), fetch(`/api/sessions/${selectedSession.id}/attachments`)]);
        if (cancelled) return;
        setEvents(loadedEvents);
        if (detailResponse.ok) {
          const detail = await detailResponse.json() as { runs: RunRecord[]; result: DevelopmentRunResult | null };
          setRuns(detail.runs); setDevelopmentResult(detail.result ?? undefined);
        }
        if (attachmentResponse.ok) setAttachments((await attachmentResponse.json() as { attachments: ImageAttachment[] }).attachments);
        if (selectedSession.status === "running") {
          source = new EventSource(`/api/sessions/${selectedSession.id}/stream?offset=${loadedEvents.length}`);
          source.addEventListener("harness-event", (message) => {
            const event = JSON.parse((message as MessageEvent<string>).data) as HarnessEvent;
            setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
          });
          source.addEventListener("end", () => { source?.close(); void refresh(); void fetch(`/api/sessions/${selectedSession.id}`).then(async (response) => { if (response.ok && !cancelled) { const detail = await response.json() as { runs: RunRecord[]; result: DevelopmentRunResult | null }; setRuns(detail.runs); setDevelopmentResult(detail.result ?? undefined); } }); });
        }
      } catch (caught) { if (!cancelled) setError(readableRuntimeError(caught, t("common.runtimeOffline"))); }
    };
    void load();
    return () => { cancelled = true; source?.close(); };
  }, [refresh, selectedSession?.id, selectedSession?.status]);

  const refreshSelected = useCallback(async () => {
    await refresh();
    if (!selectedSession) return;
    const [loadedEvents, detailResponse, attachmentResponse] = await Promise.all([fetchSessionEvents(selectedSession.id), fetch(`/api/sessions/${selectedSession.id}`), fetch(`/api/sessions/${selectedSession.id}/attachments`)]);
    setEvents(loadedEvents);
    if (detailResponse.ok) { const detail = await detailResponse.json() as { runs: RunRecord[]; result: DevelopmentRunResult | null }; setRuns(detail.runs); setDevelopmentResult(detail.result ?? undefined); }
    if (attachmentResponse.ok) setAttachments((await attachmentResponse.json() as { attachments: ImageAttachment[] }).attachments);
  }, [refresh, selectedSession]);

  async function deleteSelected() {
    if (!selectedSession || selectedSession.activeRunId) return;
    const nextSession = data.sessions.find((item) => item.id !== selectedSession.id);
    const response = await fetch(`/api/sessions/${selectedSession.id}`, { method: "DELETE" });
    if (!response.ok) { setError((await response.json() as { error?: string }).error ?? t("common.actionFailed")); return; }
    setEvents([]); setRuns([]); setAttachments([]); setDevelopmentResult(undefined);
    await refresh();
    navigate(nextSession ? { kind: "runs", sessionId: nextSession.id, tab: "overview" } : { kind: "runs", tab: "overview" }, true);
  }

  async function saveRuntime() {
    setError(""); setNotice("");
    const response = await fetch("/api/runtime", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(runtimeSettings) });
    const body = await response.json() as RuntimeSettings & { error?: string; current?: RuntimeSettings };
    if (!response.ok) {
      if (body.current) { setRuntimeSettings(body.current); setSavedRuntimeSettings(structuredClone(body.current)); }
      setError(body.error ?? t("common.saveFailed"));
      return;
    }
    setRuntimeSettings(body);
    setSavedRuntimeSettings(structuredClone(body));
    setNotice(t("settings.runtime.saved"));
  }

  async function saveConfig(nextText = configText) {
    setError(""); setNotice("");
    try {
      const config = JSON.parse(nextText) as ModelRoutingConfig;
      const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("common.saveFailed"));
      const saved = JSON.stringify(config, null, 2);
      setConfigText(saved);
      setSavedConfigText(saved);
      setNotice(t("settings.agents.saved")); await Promise.all([refresh(), loadModels(), loadMcp(), fetch("/api/capabilities").then(async (response) => { if (response.ok) setCapabilities(await response.json() as CapabilitySnapshot); })]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  function toggleMcp(name: string, enabled: boolean) {
    const config = JSON.parse(configText) as ModelRoutingConfig;
    const server = config.mcpServers?.[name];
    if (!server) return;
    const next = { ...config, mcpServers: { ...config.mcpServers, [name]: { ...server, enabled } } };
    setConfigText(JSON.stringify(next, null, 2));
  }

  function updateAgentConfig(next: ModelRoutingConfig) {
    setConfigText(JSON.stringify(next, null, 2));
  }

  function assignAgent(stage: AgentRole, agentId: string, assigned: boolean) {
    const config = JSON.parse(configText) as ModelRoutingConfig;
    const current = config.stages[stage] ?? [];
    const nextIds = assigned ? [...current, agentId].filter((id, index, all) => all.indexOf(id) === index) : current.filter((id) => id !== agentId);
    updateAgentConfig({ ...config, stages: { ...config.stages, [stage]: nextIds } });
  }

  async function stopSelected() {
    if (!selectedSession || selectedSession.status !== "running") return;
    const response = await fetch(`/api/sessions/${selectedSession.id}/stop`, { method: "POST" });
    if (!response.ok) { setError((await response.json() as { error?: string }).error ?? t("common.stopFailed")); return; }
    await refresh();
  }

  const pageTitle = route.kind === "runs" ? t("nav.runs") : route.kind === "learn" ? t("nav.learn") : t("nav.settings");
  const pageDescription = route.kind === "runs" ? t("nav.runsNote") : route.kind === "learn" ? t("nav.learnNote") : t("nav.settingsNote");
  const sessionId = selectedSession?.id ?? data.sessions[0]?.id;
  const health = useMemo(() => ({ available: data.agents.filter((agent) => agent.available).length, total: data.agents.length }), [data.agents]);
  const configDirty = configText !== savedConfigText;
  const runtimeDirty = JSON.stringify(runtimeSettings) !== JSON.stringify(savedRuntimeSettings);

  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span>RH</span><div><strong>RunHarness</strong><small>LOCAL AGENT CONTROL</small></div></a>
      <nav className="primary-nav">
        <Button variant="nav" className={route.kind === "learn" ? "active" : ""} onClick={() => navigate({ kind: "learn", topic: route.kind === "learn" ? route.topic : "harness-design" })}><BookOpenText aria-hidden="true" /><span><b>{t("nav.learn")}</b><small>{t("nav.learnNote")}</small></span></Button>
        <Button variant="nav" className={route.kind === "runs" ? "active" : ""} onClick={() => navigate(sessionId ? { kind: "runs", sessionId, tab: route.kind === "runs" ? route.tab : "overview" } : { kind: "runs", tab: "overview" })}><Activity aria-hidden="true" /><span><b>{t("nav.runs")}</b><small>{t("nav.runsNote")}</small></span></Button>
        <Button variant="nav" className={route.kind === "settings" ? "active" : ""} onClick={() => navigate({ kind: "settings", section: route.kind === "settings" ? route.section : "agents" })}><SlidersHorizontal aria-hidden="true" /><span><b>{t("nav.settings")}</b><small>{t("nav.settingsNote")}</small></span></Button>
      </nav>
      <div className={`health ${health.available ? "" : "bad"}`}><Radio aria-hidden="true" /><span>{health.available}/{health.total} {t("common.modelsReady")}</span></div>
    </aside>
    <main>
      <header className="topbar"><div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><div className="topbar-tools">
        {route.kind !== "learn" && <div className="project-select"><Select value={currentRuntime?.id ?? ""} onValueChange={(value) => { const target = runtimes.find((runtime) => runtime.id === value); if (target) window.location.assign(target.url); }}><SelectTrigger aria-label={t("common.project")}><SelectValue placeholder="RunHarness" /></SelectTrigger><SelectContent>{runtimes.map((runtime) => <SelectItem key={runtime.id} value={runtime.id}>{runtime.projectName}</SelectItem>)}</SelectContent></Select></div>}
        {route.kind === "runs" && <div className="session-select"><Select value={selectedSession?.id ?? ""} onValueChange={(value) => navigate(routeForSession(route, value))}><SelectTrigger aria-label={t("common.session")}><SelectValue placeholder={data.sessions.length ? t("common.selectSession") : t("common.noSessions")} /></SelectTrigger><SelectContent align="end" className="session-select-content">{data.sessions.map((session) => <SelectItem key={session.id} value={session.id} title={`${t(`status.${session.status}`)} · ${session.workspacePlacement === "isolated" ? t("settings.runtime.isolated") : t("settings.runtime.inPlace")} · ${session.goal}`}>{t(`status.${session.status}`)} · {session.workspacePlacement === "isolated" ? t("settings.runtime.isolated") : t("settings.runtime.inPlace")} · {session.goal}</SelectItem>)}</SelectContent></Select></div>}
        <Button variant="outline" className="language" aria-label={locale === "zh" ? "Switch to English" : "切换到中文"} onClick={() => setLocale(locale === "zh" ? "en" : "zh")}><Languages aria-hidden="true" />{locale === "zh" ? "EN" : "中文"}</Button>
      </div></header>
      {error && <Alert className="notice error"><b>{t("common.error")}</b><span>{error}</span></Alert>}{notice && <Alert className="notice success">{notice}</Alert>}
      <section className="content">
        {!loaded ? <div className="loading">{t("common.loading")}</div> : <Suspense fallback={<div className="loading">{t("common.loading")}</div>}>{route.kind === "runs" ? <RunPage
          session={selectedSession}
          runs={runs}
          events={events}
          attachments={attachments}
          result={developmentResult}
          tab={route.tab}
          eventType={route.eventType}
          onTab={(tab: RunTab) => navigate({ kind: "runs", tab, ...(route.sessionId ? { sessionId: route.sessionId } : {}) })}
          onStop={stopSelected}
          onDelete={deleteSelected}
          onRefresh={refreshSelected}
        />
          : route.kind === "learn" ? <LearnPage topic={route.topic} sessionId={sessionId} onTopic={(topic: LearnTopic) => navigate({ kind: "learn", topic })} />
          : <SettingsPage section={route.section} configText={configText} configPath={configPath} configDirty={configDirty} agents={data.agents} models={models} mcpServers={mcpServers} capabilities={capabilities} runtime={runtimeSettings} runtimeDirty={runtimeDirty} permissionCatalog={permissionCatalog} prompts={data.prompts} onSection={(section: SettingsSection) => navigate({ kind: "settings", section })} onConfigText={setConfigText} onSaveConfig={saveConfig} onDiscardConfig={() => setConfigText(savedConfigText)} onUpdateAgents={updateAgentConfig} onAssignAgent={assignAgent} onToggleMcp={toggleMcp} onRuntime={setRuntimeSettings} onSaveRuntime={saveRuntime} onDiscardRuntime={() => setRuntimeSettings(structuredClone(savedRuntimeSettings))} onRefresh={refresh} />}</Suspense>}
      </section>
    </main>
  </div>;
}
