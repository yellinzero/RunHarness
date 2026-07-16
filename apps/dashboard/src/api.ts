import type { HarnessEvent } from "@runharness/shared";

const eventPageSize = 500;

export function readableRuntimeError(error: unknown, runtimeOffline: string): string {
  if (error instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(error.message)) return runtimeOffline;
  return error instanceof Error ? error.message : String(error);
}

export async function fetchSessionEvents(sessionId: string, request: typeof fetch = fetch): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for (let offset = 0; ; offset += eventPageSize) {
    const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/events?offset=${offset}&limit=${eventPageSize}`);
    if (!response.ok) throw new Error(`Could not load events (${response.status})`);
    const page = await response.json() as HarnessEvent[];
    events.push(...page);
    if (page.length < eventPageSize) return events;
  }
}
