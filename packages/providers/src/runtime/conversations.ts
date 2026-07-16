import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ProviderConversation {
  lane: string;
  agentId: string;
  role: string;
  providerSessionId: string;
  updatedAt: string;
}

interface ProviderConversationFile {
  version: 1;
  conversations: ProviderConversation[];
}

/** 将 Provider 原生会话句柄归属到对应的 RunHarness Session 下。 */
export class ProviderConversationStore {
  private readonly memory = new Map<string, string>();
  constructor(private readonly runtimeRoot?: string) {}

  async get(sessionId: string, agentId: string, role: string): Promise<string | undefined> {
    const lane = laneKey(agentId, role);
    if (!this.runtimeRoot) return this.memory.get(`${sessionId}:${lane}`);
    const file = await this.read(sessionId);
    return file.conversations.find((item) => item.lane === lane)?.providerSessionId;
  }

  async set(sessionId: string, agentId: string, role: string, providerSessionId: string): Promise<void> {
    const lane = laneKey(agentId, role);
    if (!this.runtimeRoot) { this.memory.set(`${sessionId}:${lane}`, providerSessionId); return; }
    const file = await this.read(sessionId);
    const conversation: ProviderConversation = { lane, agentId, role, providerSessionId, updatedAt: new Date().toISOString() };
    const conversations = [...file.conversations.filter((item) => item.lane !== lane), conversation];
    const target = this.path(sessionId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ version: 1, conversations }, null, 2));
  }

  private path(sessionId: string): string {
    if (!this.runtimeRoot || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid provider conversation Session ID");
    return path.join(this.runtimeRoot, "sessions", sessionId, "provider-sessions.json");
  }

  private async read(sessionId: string): Promise<ProviderConversationFile> {
    try { return JSON.parse(await readFile(this.path(sessionId), "utf8")) as ProviderConversationFile; }
    catch { return { version: 1, conversations: [] }; }
  }
}

function laneKey(agentId: string, role: string): string { return `${agentId}:${role}`; }
