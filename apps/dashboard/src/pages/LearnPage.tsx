import { ExternalLink, Eye, Settings } from "lucide-react";
import type { LearnTopic } from "../routes";
import { useI18n } from "../i18n/provider";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

const topics: LearnTopic[] = ["harness-design", "auto-mode", "managed-agents", "long-running"];
const sources: Record<LearnTopic, { label: string; url: string }> = {
  "harness-design": { label: "AI 会写代码之后，真正稀缺的是判断力", url: "https://x.com/yellin__/article/2075509835450249474" },
  "auto-mode": { label: "How we built Claude Code auto mode: a safer way to skip permissions", url: "https://www.anthropic.com/engineering/claude-code-auto-mode" },
  "managed-agents": { label: "Scaling Managed Agents: Decoupling the brain from the hands", url: "https://www.anthropic.com/engineering/managed-agents" },
  "long-running": { label: "Harness design for long-running application development", url: "https://www.anthropic.com/engineering/harness-design-long-running-apps" },
};

const implementationPaths: Record<LearnTopic, string[]> = {
  "harness-design": [
    "packages/development/src/loop/harness.ts",
    "packages/core/src/session/store.ts",
    "packages/development/src/verification/acceptance.ts",
  ],
  "auto-mode": [
    "packages/providers/src/tools/permissions.ts",
    "packages/providers/src/tools/control-tools.ts",
    "packages/development/src/runtime/failure.ts",
  ],
  "managed-agents": [
    "packages/providers/src/routing/pool.ts",
    "packages/providers/src/runtime/backend.ts",
    "packages/development/src/workspace/manager.ts",
  ],
  "long-running": [
    "packages/core/src/session/store.ts",
    "packages/core/src/memory/store.ts",
    "packages/development/src/loop/run-context.ts",
  ],
};

export function LearnPage({ topic, sessionId, onTopic }: { topic: LearnTopic; sessionId: string | undefined; onTopic(topic: LearnTopic): void }) {
  const { t } = useI18n();
  const source = sources[topic];
  return <div className="learn-layout">
    <nav className="chapter-nav" aria-label={t("learn.chapters")}>{topics.map((item, index) => <Button variant="nav" key={item} className={topic === item ? "active" : ""} aria-current={topic === item ? "page" : undefined} onClick={() => onTopic(item)}><span>{String(index + 1).padStart(2, "0")}</span><b>{t(`learn.${item}.title`)}</b></Button>)}</nav>
    <Card className="lesson"><CardContent>
      <header className="lesson-intro"><p className="eyebrow">{t("learn.fromArticles")}</p><h2>{t(`learn.${topic}.title`)}</h2><p className="lesson-lead">{t(`learn.${topic}.lead`)}</p>
        <a className="paper-link" href={source.url} target="_blank" rel="noreferrer"><span>{t("learn.source")}</span><strong>{source.label}</strong><ExternalLink size={14} aria-hidden="true" /></a>
      </header>
      <p className="lesson-section-label">{t("learn.howItWorks")}</p>
      <div className="lesson-flow">{[1, 2, 3, 4].map((number) => <section key={number}><span>{String(number).padStart(2, "0")}</span><div><h3>{t(`learn.${topic}.points.${number}.title`)}</h3><p>{t(`learn.${topic}.points.${number}.body`)}</p></div></section>)}</div>
      <section className="lesson-implementation"><h3>{t("learn.implementationMap")}</h3><p>{t(`learn.${topic}.implementationMapHint`)}</p><div>{implementationPaths[topic].map((item) => <code key={item}>{item}</code>)}</div></section>
      <section className="lesson-actions" aria-label={t("learn.nextSteps")}>
        <article className="lesson-action primary"><div><small>{t("learn.seeIt")}</small><strong>{t(`learn.${topic}.evidence`)}</strong></div>
          {sessionId
            ? <a className="lesson-action-link" href={evidenceLink(topic, sessionId)}><Eye size={16} aria-hidden="true" />{t("learn.openEvidence")}</a>
            : <span className="lesson-action-link disabled" aria-disabled="true"><Eye size={16} aria-hidden="true" />{t("learn.noSession")}</span>}
        </article>
        <article className="lesson-action"><div><small>{t("learn.manage")}</small><strong>{t(`learn.${topic}.manage`)}</strong></div><a className="lesson-action-link" href={settingsLink(topic)}><Settings size={16} aria-hidden="true" />{t("learn.openSettings")}</a></article>
      </section>
    </CardContent></Card>
  </div>;
}

function evidenceLink(topic: LearnTopic, sessionId: string) { const id = encodeURIComponent(sessionId); const event = topic === "harness-design" ? "handoff" : topic === "auto-mode" ? "deny" : topic === "managed-agents" ? "agent_completed" : "run_started"; return `/runs/${id}/process?event=${event}`; }
function settingsLink(topic: LearnTopic) { if (topic === "managed-agents") return "/settings/agents"; return topic === "harness-design" ? "/settings/prompts" : "/settings/runtime"; }
