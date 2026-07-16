export const runTabs = ["overview", "process", "evaluation", "result"] as const;
export const learnTopics = ["harness-design", "auto-mode", "managed-agents", "long-running"] as const;
export const settingsSections = ["agents", "tools", "runtime", "prompts"] as const;

export type RunTab = (typeof runTabs)[number];
export type LearnTopic = (typeof learnTopics)[number];
export type SettingsSection = (typeof settingsSections)[number];

export type DashboardRoute =
  | { kind: "runs"; sessionId?: string; tab: RunTab; eventType?: string }
  | { kind: "learn"; topic: LearnTopic }
  | { kind: "settings"; section: SettingsSection };

export function parseRoute(pathname: string, search = ""): DashboardRoute {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  if (parts[0] === "learn" && learnTopics.includes(parts[1] as LearnTopic))
    return { kind: "learn", topic: parts[1] as LearnTopic };
  if (parts[0] === "settings" && settingsSections.includes(parts[1] as SettingsSection))
    return { kind: "settings", section: parts[1] as SettingsSection };
  if (parts[0] === "runs" && !parts[1]) return { kind: "runs", tab: "overview" };
  if (parts[0] === "runs" && parts[1]) {
    const tab = runTabs.includes(parts[2] as RunTab) ? parts[2] as RunTab : "overview";
    const params = new URLSearchParams(search);
    const eventType = params.get("event") ?? undefined;
    return {
      kind: "runs",
      sessionId: parts[1],
      tab,
      ...(eventType ? { eventType } : {}),
    };
  }
  return { kind: "learn", topic: "harness-design" };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function routePath(route: DashboardRoute): string {
  if (route.kind === "learn") return `/learn/${route.topic}`;
  if (route.kind === "settings") return `/settings/${route.section}`;
  if (!route.sessionId) return "/runs";
  const params = new URLSearchParams();
  if (route.eventType) params.set("event", route.eventType);
  const query = params.toString() ? `?${params.toString()}` : "";
  return `/runs/${encodeURIComponent(route.sessionId)}/${route.tab}${query}`;
}

export function routeForSession(route: DashboardRoute, sessionId: string): DashboardRoute {
  return route.kind === "runs"
    ? {
      kind: "runs",
      sessionId,
      tab: route.tab,
      ...(route.eventType ? { eventType: route.eventType } : {}),
    }
    : { kind: "runs", sessionId, tab: "overview" };
}
