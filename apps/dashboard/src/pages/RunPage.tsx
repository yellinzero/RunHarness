import { useEffect, useMemo, useState, type ReactNode } from "react";
import { eventsForLatestRun, explainSessionState, type DevelopmentRunResult, type EvidenceRecord, type ExplanationTopic, type HarnessEvent, type HumanReviewDecision, type ImageAttachment, type RunRecord, type SessionRecord } from "@runharness/shared";
import { useI18n } from "../i18n/provider";
import { buildProcessFlow, buildRunView, eventDetail, eventLabel, humanizeAgentText } from "../run-model";
import type { RunTab } from "../routes";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardArticle, CardContent, CardHeader } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog";
import { Markdown } from "../components/Markdown";
import { ProcessFlow } from "../components/ProcessFlow";
import { GitDiff } from "../components/GitDiff";

export function RunPage({ session, runs, events, attachments, result, tab, eventType, onTab, onStop, onDelete, onRefresh }: {
  session: SessionRecord | undefined;
  runs: RunRecord[];
  attachments: ImageAttachment[];
  events: HarnessEvent[];
  result: DevelopmentRunResult | undefined;
  tab: RunTab;
  eventType: string | undefined;
  onTab(tab: RunTab): void;
  onStop(): Promise<void>;
  onDelete(): Promise<void>;
  onRefresh(): Promise<void>;
}) {
  const { t } = useI18n();
  const [goalExpanded, setGoalExpanded] = useState(false);
  const currentEvents = useMemo(() => eventsForLatestRun(events, session?.latestRunId), [events, session?.latestRunId]);
  const currentResult = result?.runId === session?.latestRunId ? result : undefined;
  const model = useMemo(() => buildRunView(currentEvents, currentResult), [currentEvents, currentResult]);
  if (!session) return <EmptyRun />;
  return <div className="run-page">
    <section className="run-hero">
      <div>
        <div className="workspace-badges"><Badge className={`status-pill ${session.status}`}>{t(`status.${session.status}`)}</Badge><Badge>{session.workspacePlacement === "isolated" ? t("settings.runtime.isolated") : t("settings.runtime.inPlace")}</Badge><Badge>{session.workspaceAccess === "read_only" ? t("settings.runtime.readOnly") : t("settings.runtime.readWrite")}</Badge>{session.deliveryStatus && <Badge>{session.deliveryStatus}</Badge>}</div>
        <p>{t("run.goal")}</p>
        <div className={`goal-message ${goalExpanded ? "full" : ""}`}>{session.goal}</div>{session.goal.length > 180 && <Button variant="ghost" size="sm" className="goal-toggle" onClick={() => setGoalExpanded((value) => !value)}>{goalExpanded ? t("run.collapseGoal") : t("run.expandGoal")}</Button>}
      </div>
      <div className="run-next">
        <small>{t("run.currentStep")}</small>
        <strong>{model.live.label || t(`status.${session.status}`)}</strong>
        <span>{nextAction(session.status, currentResult, t)}</span>
        {session.status === "running" && <Button variant="destructive" className="danger" onClick={() => void onStop()}>{t("common.stop")}</Button>}
        {currentResult?.reviewStatus === "pending" && <Button onClick={() => onTab("evaluation")}>{t("run.reviewNow")}</Button>}
        {!session.activeRunId && <AlertDialog><AlertDialogTrigger asChild><Button variant="outline">{t("run.deleteSession")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("run.deleteSession")}</AlertDialogTitle><AlertDialogDescription>{t("run.deleteDescription", { count: attachments.length })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void onDelete()}>{t("run.deleteConfirm")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
      </div>
    </section>
    <ActionRequired session={session} result={currentResult} onRefresh={onRefresh} />
    {attachments.length > 0 && <section className="session-attachments" aria-label={t("run.attachments")}><div><strong>{t("run.attachments")}</strong><span>{attachments.length}/10</span></div><div className="attachment-grid">{attachments.map((attachment) => <a key={attachment.id} href={`/api/sessions/${session.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer"><img src={`/api/sessions/${session.id}/attachments/${attachment.id}`} alt={attachment.name} /><span>{attachment.name}</span></a>)}</div></section>}
    <Tabs value={tab} onValueChange={(value) => onTab(value as RunTab)}><TabsList className="subnav" aria-label={t("run.sections")}>
      {(["overview", "process", "evaluation", "result"] as const).map((item) =>
        <TabsTrigger key={item} value={item}>{t(`run.tabs.${item}`)}</TabsTrigger>)}
    </TabsList></Tabs>
    {tab === "overview" && <Overview session={session} model={model} result={currentResult} events={currentEvents} />}
    {tab === "process" && <Process session={session} runs={runs} events={events} result={result} eventType={eventType} />}
    {tab === "evaluation" && <Evaluation session={session} model={model} events={currentEvents} result={currentResult} onTab={onTab} onRefresh={onRefresh} />}
    {tab === "result" && <Result session={session} result={currentResult} onRefresh={onRefresh} />}
  </div>;
}

function ActionRequired({ session, result, onRefresh }: { session: SessionRecord; result: DevelopmentRunResult | undefined; onRefresh(): Promise<void> }) {
  const { t } = useI18n(); const [planText, setPlanText] = useState(result?.plan?.text ?? ""); const [reason, setReason] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setPlanText(result?.plan?.text ?? ""); }, [result?.plan?.text]);
  async function decidePlan(decision: "approve" | "revise" | "reject") {
    if (!result?.plan) return; setBusy(true); setMessage("");
    const response = await fetch(`/api/sessions/${session.id}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: result.plan.version, decision, ...(decision === "revise" ? { revisedPlan: planText.trim() } : {}), ...(decision === "reject" ? { reason: reason.trim() || t("approval.rejected") } : {}) }) });
    const body = await response.json() as { error?: string }; setBusy(false); setMessage(response.ok ? t("approval.saved") : body.error ?? t("common.actionFailed")); if (response.ok) await onRefresh();
  }
  async function decidePermission(decision: "approve" | "reject", scope: "once" | "session" | "project") {
    if (!result?.pendingApproval) return; setBusy(true); setMessage("");
    const response = await fetch(`/api/sessions/${session.id}/permissions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: result.pendingApproval.id, decision, scope, ...(reason.trim() ? { reason: reason.trim() } : {}) }) });
    const body = await response.json() as { error?: string }; setBusy(false); setMessage(response.ok ? t("approval.saved") : body.error ?? t("common.actionFailed")); if (response.ok) await onRefresh();
  }
  if (session.status === "waiting_for_plan_approval" && result?.plan) return <section className="action-required" aria-label={t("approval.planTitle")}><header><Badge>{t("approval.actionRequired")}</Badge><div><h2>{t("approval.planTitle")}</h2><p>{t("approval.planHint", { version: result.plan.version })}</p></div></header><Textarea value={planText} onChange={(event) => setPlanText(event.target.value)} /><section className="markdown-preview"><small>{t("approval.preview")}</small><Markdown>{planText}</Markdown></section><label>{t("approval.reason")}<Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("approval.reasonPlaceholder")} /></label><div className="approval-actions"><Button disabled={busy} onClick={() => void decidePlan("approve")}>{t("approval.approvePlan")}</Button><Button variant="secondary" disabled={busy || !planText.trim() || planText.trim() === result.plan?.text.trim()} onClick={() => void decidePlan("revise")}>{t("approval.revisePlan")}</Button><Button variant="destructive" disabled={busy} onClick={() => void decidePlan("reject")}>{t("approval.rejectPlan")}</Button></div>{message && <p role="status">{message}</p>}</section>;
  if (session.status === "waiting_for_permission" && result?.pendingApproval) return <section className="action-required permission-approval" aria-label={t("approval.permissionTitle")}><header><Badge>{t("approval.actionRequired")}</Badge><div><h2>{t("approval.permissionTitle")}</h2><p>{result.pendingApproval.action.summary}</p></div></header><dl><div><dt>{t("approval.actionKind")}</dt><dd>{result.pendingApproval.action.kind}</dd></div><div><dt>{t("approval.policyReason")}</dt><dd>{result.pendingApproval.baseDecision.reason}</dd></div>{result.pendingApproval.action.tool && <div><dt>MCP</dt><dd>{result.pendingApproval.action.server}/{result.pendingApproval.action.tool}</dd></div>}</dl><label>{t("approval.reason")}<Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("approval.permissionReasonPlaceholder")} /></label><div className="approval-actions"><Button disabled={busy} onClick={() => void decidePermission("approve", "once")}>{t("approval.allowOnce")}</Button><Button variant="secondary" disabled={busy} onClick={() => void decidePermission("approve", "session")}>{t("approval.allowSession")}</Button><Button variant="secondary" disabled={busy} onClick={() => void decidePermission("approve", "project")}>{t("approval.allowProject")}</Button><Button variant="destructive" disabled={busy} onClick={() => void decidePermission("reject", "once")}>{t("approval.rejectAction")}</Button></div>{message && <p role="status">{message}</p>}</section>;
  return null;
}

function Overview({ session, model, result, events }: { session: SessionRecord; model: ReturnType<typeof buildRunView>; result: DevelopmentRunResult | undefined; events: HarnessEvent[] }) {
  const { t } = useI18n();
  const planSummary = model.plan || t("common.waitingEvidence");
  const flow = useMemo(() => buildProcessFlow(events, result), [events, result]);
  return <>
    <section className="workflow-flow" aria-label={t("run.workflow")}><ProcessFlow model={flow} height={250} /></section>
    {(session.status === "running" || model.live.label) && <div className="live-cursor" role="status">
      <span>{t("process.live")}</span>
      <strong>{model.live.label}</strong>
      {model.agents.length > 0 && <small>{model.agents.map(formatAgent).join(" · ")}</small>}
    </div>}
    <section className="metrics" aria-label={t("run.performance")}>
      <Metric value={formatDuration(model.metrics.totalMs)} label={t("metrics.total")} />
      <Metric value={formatDuration(model.metrics.agentMs)} label={t("metrics.model")} />
      <Metric value={formatDuration(model.metrics.checkMs)} label={t("metrics.checks")} />
      <Metric value={model.metrics.toolCalls} label={t("metrics.tools")} />
      <Metric value={model.metrics.iterations} label={t("metrics.iterations")} />
    </section>
    <div className="two-column">
      <Panel title={t("run.whatHappened")} note={t("run.whatHappenedNote")}>
        <Fact label={t("run.planningOutput")} value={planSummary} markdown />
        <Fact label={t("run.implementationOutput")} value={model.generatorSummary || t("common.waitingEvidence")} markdown />
        <Fact label={t("run.checkEvidence")} value={model.evidence.length ? `${model.evidence.filter((item) => item.status === "passed").length}/${model.evidence.length} ${t("common.passed")}` : t("common.waitingEvidence")} />
        <Fact label={t("run.reviewOutput")} value={model.reviews.at(-1)?.text || t("common.waitingEvidence")} markdown />
      </Panel>
      <Panel title={t("run.outcome")} note={t("run.outcomeNote")}>
        <Fact label={t("common.status")} value={t(`status.${session.status}`)} />
        <Fact label={t("metrics.iterations")} value={String(result?.iterations ?? model.metrics.iterations)} />
        <Fact label={t("process.modelsUsed")} value={model.agents.length ? model.agents.map(formatAgent).join(" · ") : t("common.notAvailable")} />
        <Fact label={t("result.changedFiles")} value={String(result?.changes.changedFiles.length ?? 0)} />
        <Fact label={t("result.deliveryMode")} value={result?.placement ? t(`result.placement.${result.placement}`) : t("common.notAvailable")} />
      </Panel>
    </div>
  </>;
}

function Process({ session, runs, events, result, eventType }: {
  session: SessionRecord;
  runs: RunRecord[];
  events: HarnessEvent[];
  result: DevelopmentRunResult | undefined;
  eventType: string | undefined;
}) {
  const { t } = useI18n();
  const model = useMemo(() => buildRunView(events, result), [events, result]);
  const flow = useMemo(() => buildProcessFlow(events, result), [events, result]);
  const visible = useMemo(() => {
    if (eventType) return events.filter((event) => event.type === eventType);
    return events;
  }, [eventType, events]);
  const groups = useMemo(() => groupProcessEvents(runs, visible), [runs, visible]);
  const focusEventId = useMemo(() => {
    if (!eventType) return undefined;
    return [...visible].sort((a, b) => b.sequence - a.sequence)[0]?.id;
  }, [eventType, visible]);

  useEffect(() => {
    if (!focusEventId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`event-${focusEventId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusEventId, eventType]);

  return <div className="process-layout">
    <section className="workflow-flow" aria-label={t("run.workflow")}><ProcessFlow model={flow} height={230} /></section>
    {(session.status === "running" || model.live.label) && <div className="live-cursor compact" role="status">
      <span>{t("process.live")}</span>
      <strong>{model.live.label}</strong>
      {model.agents.length > 0 && <small>{model.agents.map(formatAgent).join(" · ")}</small>}
    </div>}
    <Panel title={t("process.title")} note={eventType ? t("process.filtered", { event: eventType }) : t("process.note")}>
      {eventType && <div className="stage-focus-banner">
        <div>
          <strong>{eventType}</strong>
          <span> · {t("process.filteredHint", { count: visible.length })}</span>
        </div>
      </div>}
      {visible.length === 0 ? <EmptyState title={t("process.empty")} body={t("process.emptyHint")} /> : <div className="process-runs" key={eventType ?? "all"}>{groups.map((group, runIndex) => {
        const openRun = runIndex === 0 || group.iterations.some((item) => item.events.some((event) => event.id === focusEventId));
        return <Collapsible key={group.run.id} defaultOpen={openRun} className="process-run">
          <CollapsibleTrigger>
            <strong>{group.run.message}</strong>
            <span>{t("metrics.iterations")}: {Math.max(0, ...group.iterations.map((item) => item.number))} · {t(`status.${group.run.status}`)} · {group.iterations.reduce((sum, item) => sum + item.events.length, 0)} events</span>
          </CollapsibleTrigger>
          <CollapsibleContent>{group.iterations.map((iteration, iterationIndex) => {
            const agents = summarizeIterationAgents(iteration.events);
            const hasFocus = iteration.events.some((event) => event.id === focusEventId);
            const openIteration = hasFocus || (runIndex === 0 && iterationIndex === 0);
            return <Collapsible key={`${group.run.id}-${iteration.number}`} defaultOpen={openIteration} className={`process-iteration${hasFocus ? " is-focus" : ""}`}>
              <CollapsibleTrigger>
                <strong>{iteration.number ? t("metrics.iteration", { count: iteration.number }) : t("process.initialActivity")}</strong>
                <span>{iteration.events.length} events · {agents || iteration.latest?.actor || "system"} · {iteration.latest ? eventLabel(iteration.latest) : "waiting"}</span>
              </CollapsibleTrigger>
              <CollapsibleContent><div className="event-list">{[...iteration.events].reverse().map((event) => {
                const detail = eventDetail(event);
                const isFocus = event.id === focusEventId;
                return <article className={`event-row${isFocus ? " is-focus" : ""}`} id={`event-${event.id}`} key={event.id}>
                  <time>{new Date(event.timestamp).toLocaleString()}</time>
                  <Badge className={`actor ${event.actor}`}>{["planner", "generator", "evaluator"].includes(event.actor) ? "agent" : event.actor}</Badge>
                  <div>
                    <strong>{eventLabel(event)}</strong>
                    {detail && (event.type === "agent_failed"
                      ? <pre className="event-detail">{detail}</pre>
                      : <p className="event-detail">{detail}</p>)}
                    <small>#{event.sequence} · {event.type}</small>
                    <Collapsible defaultOpen={isFocus}>
                      <CollapsibleTrigger>{t("process.raw")}</CollapsibleTrigger>
                      <CollapsibleContent><pre>{formatPayload(event.payload)}</pre></CollapsibleContent>
                    </Collapsible>
                  </div>
                </article>;
              })}</div></CollapsibleContent>
            </Collapsible>;
          })}</CollapsibleContent>
        </Collapsible>;
      })}</div>}
    </Panel>
  </div>;
}

function formatAgent(agent: { role: string; agentId?: string; model?: string; iteration?: number }): string {
  return [agent.role, agent.iteration ? `r${agent.iteration}` : undefined, agent.agentId, agent.model].filter(Boolean).join(":");
}

function summarizeIterationAgents(events: HarnessEvent[]): string {
  const labels = new Set<string>();
  for (const event of events) {
    if (!["agent_started", "agent_completed", "tool_call", "verdict"].includes(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    const agent = String(payload.agentId ?? payload.backend ?? payload.reviewer ?? "");
    const model = String(payload.model ?? "");
    const label = [["planner", "generator", "evaluator"].includes(event.actor) ? "agent" : event.actor, agent, model].filter(Boolean).join(":");
    if (label) labels.add(label);
  }
  return [...labels].slice(0, 4).join(" · ");
}

export function groupProcessEvents(runs: RunRecord[], events: HarnessEvent[]) {
  const byRun = new Map<string, Array<{ event: HarnessEvent; iteration: number }>>();
  const currentIteration = new Map<string, number>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const payload = event.payload as Record<string, unknown>;
    const explicit = typeof payload?.iteration === "number" ? payload.iteration : undefined;
    if (explicit !== undefined) currentIteration.set(event.runId, explicit);
    const iteration = explicit ?? currentIteration.get(event.runId) ?? 0;
    byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), { event, iteration }]);
  }
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => {
    const entries = byRun.get(run.id) ?? [];
    const numbers = [...new Set(entries.map((item) => item.iteration))].sort((a, b) => b - a);
    return { run, iterations: numbers.map((number) => { const iterationEvents = entries.filter((item) => item.iteration === number).map((item) => item.event); return { number, events: iterationEvents, latest: iterationEvents.at(-1) }; }) };
  });
}

interface ReviewEvidence {
  changedFiles: string[];
  generatorSummary?: string;
  acceptance: Array<{ name: string; runtime: string; status: EvidenceRecord["status"]; blocking: boolean }>;
  actions: Array<{ summary: string; success: boolean }>;
}

function Evaluation({ session, model, events, result, onTab, onRefresh }: { session: SessionRecord; model: ReturnType<typeof buildRunView>; events: HarnessEvent[]; result: DevelopmentRunResult | undefined; onTab(tab: RunTab): void; onRefresh(): Promise<void> }) {
  const { t } = useI18n();
  const evidence = useMemo(() => buildReviewEvidence(model, events, result), [events, model, result]);
  return <div className="evaluation-layout">
    <Panel title={t("evaluation.checks")} note={t("evaluation.checksNote")}>
      {model.evidence.length === 0 ? <EmptyState title={t(session.status === "running" ? "evaluation.noChecks" : "evaluation.noChecksConfigured")} body={session.status === "running" ? t("evaluation.runningHint") : t("evaluation.noChecksHint")} /> :
        <div className="check-list">{model.evidence.map((item) => <CardArticle key={item.id} className={item.status === "passed" ? "pass" : item.blocksCompletion ? "fail" : ""}>
          <div><Badge>{item.status}</Badge><strong>{acceptanceName(item)}</strong><time>{formatDuration(item.durationMs ?? 0)}</time></div>
          <code>{[item.runtimeId ?? item.owner, item.placement, item.requirement].join(" · ")}</code>
          <p>{item.summary}</p>
          {item.failureCategory && <small>{item.failureCategory}{item.blocksCompletion ? " · blocks completion" : " · evidence only"}</small>}
          {item.native !== undefined && <Collapsible><CollapsibleTrigger>{t("evaluation.output")}</CollapsibleTrigger><CollapsibleContent><pre>{formatPayload(item.native)}</pre></CollapsibleContent></Collapsible>}
        </CardArticle>)}</div>}
    </Panel>
    <Panel title={t("evaluation.reviews")} note={t("evaluation.reviewsNote")}>
      {model.reviews.length === 0 ? <EmptyState title={t("evaluation.noReviews")} body={session.status === "running" ? t("evaluation.runningHint") : t("evaluation.noReviewsHint")} /> :
        <div className="review-list">{model.reviews.map((review, index) => <ReviewCard key={review.sourceEventId ?? `${review.reviewer}-${index}`} review={review} evidence={evidence} reviewed={Boolean(review.sourceEventId && events.some((item) => item.type === "human_reviewed" && (item.payload as Partial<HumanReviewDecision>).eventId === review.sourceEventId))} onOpenEvidence={onTab} onRefresh={onRefresh} />)}</div>}
    </Panel>
  </div>;
}

function ReviewCard({ review, evidence, reviewed, onOpenEvidence, onRefresh }: { review: ReturnType<typeof buildRunView>["reviews"][number]; evidence: ReviewEvidence; reviewed: boolean; onOpenEvidence(tab: RunTab): void; onRefresh(): Promise<void> }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [evidenceReviewed, setEvidenceReviewed] = useState(false);
  async function submit(decision: HumanReviewDecision["decision"]) {
    if (!review.sourceEventId) return;
    if (!reason.trim()) { setMessage(t("evaluation.reasonRequired")); return; }
    setSaving(true); setMessage("");
    const response = await fetch("/api/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: review.sourceEventId, decision, reason: reason.trim() }) });
    const body = await response.json() as { error?: string };
    setSaving(false);
    if (!response.ok) { setMessage(body.error ?? t("common.saveFailed")); return; }
    setMessage(t("evaluation.saved")); await onRefresh();
  }
  const serviceFailed = review.status === "control_missing" || review.decision === "unavailable";
  const hasImplementationEvidence = evidence.changedFiles.length > 0;
  return <CardArticle className={`review-card ${serviceFailed ? "" : review.decision === "accept" ? "pass" : "fail"}`}>
    <header><Badge>{serviceFailed ? t("evaluation.reviewPending") : review.decision === "accept" ? t("common.pass") : t("common.fail")}</Badge><strong>{review.reviewer}</strong>{review.iteration && <small>{t("metrics.iteration", { count: review.iteration })}</small>}</header>
    {serviceFailed ? <><div className="review-service-summary"><strong>{t("evaluation.serviceUnavailableTitle")}</strong><p>{t("evaluation.reviewPendingHint")}</p></div>
      <Collapsible className="review-technical"><CollapsibleTrigger>{t("evaluation.technicalDetails")}</CollapsibleTrigger><CollapsibleContent><Markdown>{review.text || t("evaluation.reviewUnavailable")}</Markdown></CollapsibleContent></Collapsible></> : <Markdown>{review.text}</Markdown>}
    {serviceFailed && <ReviewEvidenceSummary evidence={evidence} onOpen={onOpenEvidence} />}
    {review.sourceEventId && (!serviceFailed || hasImplementationEvidence) ? <div className="review-decision-box"><label>{serviceFailed ? t("evaluation.serviceFailureReason") : t("evaluation.humanReason")}<Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={serviceFailed ? t("evaluation.serviceFailurePlaceholder") : t("evaluation.reasonPlaceholder")} /></label>
      {serviceFailed && <label className="review-evidence-ack"><Checkbox checked={evidenceReviewed} onCheckedChange={(checked) => setEvidenceReviewed(checked === true)} /><span>{t("evaluation.evidenceAcknowledgement")}</span></label>}
      <div>{serviceFailed ? <Button disabled={saving || reviewed || !evidenceReviewed} onClick={() => void submit("accept")}>{t("evaluation.approveImplementation")}</Button> : <><Button disabled={saving || reviewed} onClick={() => void submit("accept")}>{t("evaluation.agree")}</Button><Button variant="secondary" disabled={saving || reviewed} onClick={() => void submit("reject")}>{t("evaluation.disagree")}</Button></>}</div>
      {(reviewed || message) && <small role="status">{reviewed ? t("evaluation.alreadyReviewed") : message}</small>}
    </div> : <p className="review-decision-unavailable">{serviceFailed && !hasImplementationEvidence ? t("evaluation.insufficientEvidence") : t("evaluation.reviewUnavailable")}</p>}
  </CardArticle>;
}

function ReviewEvidenceSummary({ evidence, onOpen }: { evidence: ReviewEvidence; onOpen(tab: RunTab): void }) {
  const { t } = useI18n();
  return <section className="review-evidence"><h4>{t("evaluation.evidenceTitle")}</h4>
    <div><strong>{t("evaluation.changedFilesEvidence", { count: evidence.changedFiles.length })}</strong>{evidence.changedFiles.length ? <ul>{evidence.changedFiles.slice(0, 8).map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <p>{t("evaluation.noChangedFilesEvidence")}</p>}</div>
    {evidence.acceptance.length > 0 && <div><strong>{t("evaluation.structuredChecksEvidence")}</strong><ul>{evidence.acceptance.map((item) => <li key={`${item.name}-${item.runtime}`}><Badge>{item.status}</Badge><code>{item.name} · {item.runtime}{item.blocking ? " · required" : ""}</code></li>)}</ul></div>}
    {evidence.actions.length > 0 && <div><strong>{t("evaluation.toolEvidence")}</strong><ul>{evidence.actions.map((action, index) => <li key={`${action.summary}-${index}`}><Badge>{action.success ? t("common.pass") : t("common.fail")}</Badge><code>{action.summary}</code></li>)}</ul></div>}
    <footer><Button variant="secondary" onClick={() => onOpen("process")}>{t("evaluation.openProcessEvidence")}</Button><Button variant="secondary" onClick={() => onOpen("result")}>{t("evaluation.openDiffEvidence")}</Button></footer>
    {evidence.generatorSummary && <Collapsible className="review-generator-detail"><CollapsibleTrigger>{t("evaluation.generatorEvidence")}</CollapsibleTrigger><CollapsibleContent><Markdown>{evidence.generatorSummary}</Markdown></CollapsibleContent></Collapsible>}
  </section>;
}

function buildReviewEvidence(model: ReturnType<typeof buildRunView>, events: HarnessEvent[], result: DevelopmentRunResult | undefined): ReviewEvidence {
  const calls = new Map<string, string>();
  for (const event of events) {
    if (event.actor !== "generator" || event.type !== "tool_call") continue;
    const payload = event.payload as Record<string, unknown>;
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const summary = String(payload.summary ?? payload.command ?? payload.name ?? payload.tool ?? "").trim();
    if (callId && summary) calls.set(callId, summary);
  }
  const actions = events.flatMap((event) => {
    if (event.actor !== "generator" || event.type !== "tool_result") return [];
    const payload = event.payload as Record<string, unknown>;
    if (payload.evidence || typeof payload.success !== "boolean") return [];
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const summary = calls.get(callId) ?? String(payload.summary ?? payload.tool ?? "").trim();
    return summary ? [{ summary, success: payload.success }] : [];
  }).slice(-6);
  return {
    changedFiles: result?.changes.changedFiles ?? [],
    ...(model.generatorSummary ? { generatorSummary: model.generatorSummary } : {}),
    acceptance: model.evidence.map((item) => ({ name: acceptanceName(item), runtime: item.runtimeId ?? item.placement, status: item.status, blocking: item.blocksCompletion })),
    actions,
  };
}

function Result({ session, result, onRefresh }: { session: SessionRecord; result: DevelopmentRunResult | undefined; onRefresh(): Promise<void> }) {
  const { t, locale } = useI18n();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function deliver(action: "apply" | "discard") {
    setBusy(true); setMessage("");
    const response = await fetch(`/api/sessions/${session.id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await response.json() as { error?: string; files?: string[]; action?: string };
    setBusy(false);
    setMessage(response.ok ? t(`result.${action}Success`, { count: body.files?.length ?? 0 }) : body.error ?? t("common.actionFailed"));
    await onRefresh();
  }
  if (!result) return <Panel title={t("result.title")} note={t("result.note")}><EmptyState title={t("result.notReady")} body={session.status === "running" ? t("result.runningHint") : t("result.missingHint")} /></Panel>;
  const deliveryStatus = session.deliveryStatus === "conflict" ? "conflict" : result.delivery?.status ?? "pending";
  return <div className="result-layout">
    <Panel title={t("result.title")} note={result.placement === "in_place" ? t("result.inPlaceNote") : t("result.isolatedNote")}>
      <div className="result-banner"><strong>{result.reviewStatus === "pending" ? t("result.pendingReview") : result.completed ? t("result.completed") : t("result.incomplete")}</strong><span>{t(`result.placement.${result.placement}`)}</span></div>
      <ConceptExplanation topic={result.placement === "isolated" ? "delivery" : "workspace"} session={session} result={result} locale={locale} />
      <h3>{t("result.changedFiles")}</h3>
      {result.changes.changedFiles.length ? <ul className="file-list">{result.changes.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <EmptyState title={t("result.noChanges")} body={t("result.noChangesHint")} />}
      {result.placement === "isolated" && deliveryStatus === "pending" && <div className="delivery-actions"><Button disabled={busy || session.status === "running"} onClick={() => void deliver("apply")}>{t("result.apply")}</Button><Button variant="secondary" disabled={busy || session.status === "running"} onClick={() => void deliver("discard")}>{t("result.discard")}</Button></div>}
      {result.placement === "isolated" && deliveryStatus !== "pending" && <p className={`delivery-state ${deliveryStatus}`} role="status">{t(`result.delivery.${deliveryStatus}`)}</p>}
      {message && <p className="action-message" role="status">{message}</p>}
      {session.status !== "running" && <div className="session-continuation"><strong>{t("result.continueTitle")}</strong><p>{t("result.continueHint")}</p><code>/session</code><code>/continue {t("result.continuePlaceholder")}</code></div>}
    </Panel>
    <Panel title={t("result.diff")} note={result.workspace}><Collapsible defaultOpen><CollapsibleTrigger>{t("result.statusAndDiff")}</CollapsibleTrigger><CollapsibleContent><GitDiff status={result.changes.status} diff={result.changes.diff} /></CollapsibleContent></Collapsible></Panel>
  </div>;
}

function ConceptExplanation({ topic, session, result, locale }: { topic: ExplanationTopic; session: SessionRecord; result?: DevelopmentRunResult; locale: "en" | "zh" }) {
  const explanation = explainSessionState(topic, session, result, locale);
  return <Collapsible className="concept-explanation"><CollapsibleTrigger>{locale === "zh" ? "为什么要这样操作？" : "Why does RunHarness work this way?"}</CollapsibleTrigger><CollapsibleContent><h3>{explanation.title}</h3><p>{explanation.summary}</p><dl><div><dt>{locale === "zh" ? "原因" : "Why"}</dt><dd>{explanation.why}</dd></div><div><dt>{locale === "zh" ? "会改变" : "Changes"}</dt><dd>{explanation.changes}</dd></div><div><dt>{locale === "zh" ? "会保留" : "Remains"}</dt><dd>{explanation.remains}</dd></div></dl><ul>{explanation.actions.map((action) => <li key={action}>{action}</li>)}</ul><a href={`/learn/${explanation.learnTopic}`}>{locale === "zh" ? "在学习区了解这个 Harness 概念" : "Learn this Harness concept"}</a></CollapsibleContent></Collapsible>;
}

function EmptyRun() { const { t } = useI18n(); return <div className="onboarding"><span>01</span><h2>{t("empty.title")}</h2><p>{t("empty.body")}</p><code>runharness</code><ol><li>{t("empty.step1")}</li><li>{t("empty.step2")}</li><li>{t("empty.step3")}</li></ol></div>; }
function Panel({ title, note, children }: { title: string; note: string; children: ReactNode }) { return <Card className="panel"><CardHeader className="panelhead"><h2>{title}</h2><p>{note}</p></CardHeader><CardContent>{children}</CardContent></Card>; }
function Metric({ value, label }: { value: string | number; label: string }) { return <div className="metric"><strong>{value}</strong><span>{label}</span></div>; }
function Fact({ label, value, markdown = false }: { label: string; value: string; markdown?: boolean }) { return <div className="fact"><small>{label}</small>{markdown ? <Markdown>{value}</Markdown> : <p>{value}</p>}</div>; }
function EmptyState({ title, body }: { title: string; body: string }) { return <div className="empty-state"><strong>{title}</strong><span>{body}</span></div>; }
function formatDuration(ms: number) { if (!ms) return "—"; if (ms < 1000) return `${ms}ms`; if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`; return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`; }
function acceptanceName(evidence: EvidenceRecord): string {
  const native = evidence.native && typeof evidence.native === "object" && !Array.isArray(evidence.native) ? evidence.native as Record<string, unknown> : {};
  const spec = native.acceptance && typeof native.acceptance === "object" && !Array.isArray(native.acceptance) ? native.acceptance as Record<string, unknown> : {};
  return typeof spec.name === "string" ? spec.name : evidence.capability;
}
function formatPayload(value: unknown) {
  try {
    if (typeof value === "string") return humanizeAgentText(value) === value ? value : `${humanizeAgentText(value)}\n\n--- raw ---\n${value}`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const next = { ...record };
      for (const key of ["plan", "summary", "message", "text"] as const) {
        if (typeof next[key] === "string") next[key] = humanizeAgentText(next[key]);
      }
      return JSON.stringify(next, null, 2);
    }
    return JSON.stringify(value, null, 2);
  } catch { return String(value); }
}
function nextAction(status: SessionRecord["status"], result: DevelopmentRunResult | undefined, t: (key: string) => string) { if (status === "running") return t("run.nextObserve"); if (status === "waiting_for_plan_approval") return t("run.nextPlanApproval"); if (status === "waiting_for_permission") return t("run.nextPermissionApproval"); if (status === "failed") return t("run.nextInspect"); if (status === "stopped") return t("run.nextStopped"); if (result?.reviewStatus === "pending") return t("run.nextReviewPending"); if (result?.placement === "isolated" && (result.delivery?.status ?? "pending") === "pending") return t("run.nextDeliver"); if (result?.delivery?.status === "discarded") return t("run.nextDiscarded"); return t("run.nextComplete"); }
