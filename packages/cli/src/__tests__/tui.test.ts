import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { DevelopmentRunResult } from "@runharness/shared";
import { buildTuiResultSummary } from "../ui/result-summary.js";
import { CommandPalette, Composer, Conversation, HarnessTui, HelpOverview, SLASH_COMMANDS, buildResultTranscriptItems, buildTranscriptItems, composerCursorPosition, composerTextParts, composerViewport, composerWordBoundary, deleteComposerRange, deletePreviousGrapheme, fetchAllSessionEvents, fitTranscriptItems, fitTranscriptItemsAtOffset, moveComposerCursorVertical, sessionStatusBar, slashCommandCompletion, splitGraphemes, streamSessionEvents, suggestSlashCommands, toolDetailLines } from "../ui/tui.js";

function terminalStream(): PassThrough & NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stream, { columns: 80, rows: 24, isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  return stream;
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

describe("composer multiline geometry", () => {
  it("moves vertically by visual rows while preserving the preferred column", () => {
    const down = moveComposerCursorVertical("abcdefghi", 3, 4, 1);
    expect(down).toEqual({ cursorIndex: 7, preferredColumn: 3 });
    expect(moveComposerCursorVertical("abcdefghi", down.cursorIndex, 4, 1, down.preferredColumn)).toEqual({ cursorIndex: 9, preferredColumn: 3 });
    expect(moveComposerCursorVertical("abcdefghi", 3, 4, -1)).toEqual({ cursorIndex: 0, preferredColumn: 3 });
    expect(moveComposerCursorVertical("abcdefghi", 7, 4, 1)).toEqual({ cursorIndex: 9, preferredColumn: 3 });
  });

  it("moves and deletes by Unicode word boundaries", () => {
    const input = "fix 中文 input";
    expect(composerWordBoundary(input, splitGraphemes(input).length, -1)).toBe(7);
    expect(deleteComposerRange(input, 7, splitGraphemes(input).length)).toEqual({ input: "fix 中文 ", cursorIndex: 7 });
  });

  it("keeps the cursor inside a bounded long-draft viewport", () => {
    const viewport = composerViewport("one\ntwo\nthree\nfour\nfive", 23, 20, 3);
    expect(viewport.text).toBe("three\nfour\nfive");
    expect(viewport.linesAbove).toBe(2);
    expect(viewport.linesBelow).toBe(0);
    expect(viewport.cursorIndex).toBe(splitGraphemes(viewport.text).length);
    const middle = composerViewport("one\ntwo\nthree\nfour\nfive", 4, 20, 3);
    expect(middle.text.endsWith("\n")).toBe(false);
    expect(middle.linesBelow).toBeGreaterThan(0);
  });
});

async function openFirstSession(stdin: PassThrough & NodeJS.WriteStream) {
  stdin.write("/session\r");
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe("TUI Session startup", () => {
  it("exits on Kitty Ctrl+C without inserting a literal c", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("draft"); stdin.write("\u001b[99;5u"); stdin.write("\u001b[99;5:3u");
    await Promise.race([instance.waitUntilExit(), new Promise((_, reject) => setTimeout(() => reject(new Error("Kitty Ctrl+C did not exit")), 300))]);
    const plain = stripAnsi(rendered);
    expect(plain).not.toContain("draftc");
    instance.unmount(); vi.unstubAllGlobals();
  });

  it("uses Kitty Ctrl+C to stop an active Run instead of exiting", async () => {
    let stopped = false; const posts: string[] = [];
    const session = () => ({ id: "session_live", goal: "active", status: stopped ? "stopped" : "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: stopped ? undefined : "run_live" });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session()] });
      if (url.endsWith("/api/sessions/session_live") && method === "GET") return Response.json({ session: session() });
      if (url.endsWith("/api/sessions/session_live/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_live/events?")) return Response.json([]);
      if (url.includes("/api/sessions/session_live/stream?")) return new Response("event: end\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.endsWith("/api/sessions/session_live/stop") && method === "POST") { posts.push(url); stopped = true; return Response.json({}); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("\u001b[99;5u"); stdin.write("\u001b[99;5:2u"); stdin.write("\u001b[99;5:3u"); await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toEqual(["http://runtime/api/sessions/session_live/stop"]);
    instance.unmount(); vi.unstubAllGlobals();
  });

  it("reconciles a stale running Session and lets Ctrl+C exit without a stop request", async () => {
    let detailReads = 0; let stopRequests = 0;
    const running = { id: "session_stale", goal: "active", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_live", latestRunId: "run_live" };
    const completed = { ...running, status: "completed", activeRunId: undefined };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [running] });
      if (url.endsWith("/api/sessions/session_stale") && method === "GET") return Response.json({ session: detailReads++ === 0 ? running : completed });
      if (url.endsWith("/api/sessions/session_stale/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_stale/events?")) return Response.json([]);
      if (url.includes("/api/sessions/session_stale/stream?")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      if (url.endsWith("/api/sessions/session_stale/stop") && method === "POST") { stopRequests += 1; return Response.json({ status: "completed" }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\u001b[99;5u"); stdin.write("\u001b[99;5:3u");
    await Promise.race([instance.waitUntilExit(), new Promise((_, reject) => setTimeout(() => reject(new Error("stale Session did not exit")), 400))]);
    expect(stopRequests).toBe(0);
    instance.unmount(); vi.unstubAllGlobals();
  });

  it("keeps legacy iTerm Shift+Enter, Kitty Shift+Enter, and Ctrl+J in the composer", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("first"); stdin.write("\u001b\r"); stdin.write("second"); stdin.write("\u001b[13;2u"); stdin.write("\u001b[13;2:3u"); stdin.write("third"); stdin.write("\n"); stdin.write("fourth"); stdin.write("\u001b[106;5u"); stdin.write("\u001b[106;5:3u"); stdin.write("fifth");
    await new Promise((resolve) => setTimeout(resolve, 60));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("first"); expect(composer).toContain("second"); expect(composer).toContain("third"); expect(composer).toContain("fourth"); expect(composer).toContain("fifth");
    expect(composer).not.toContain("[13;2:3u");
    expect(composer).not.toContain("fourthj");
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
  });

  it("inserts a multiline bracketed paste without submitting", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[200~alpha\r\nbeta\u001b[201~");
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("alpha"); expect(composer).toContain("beta");
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
  });

  it("restores a submitted command from local history and undoes one edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/help\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r"); stdin.write("\u001b[A"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("x"); stdin.write("\u001f"); await new Promise((resolve) => setTimeout(resolve, 40));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("/help"); expect(composer).not.toContain("/helpx");
  });

  it("keeps a newly typed draft in visual-line navigation instead of entering history", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/help\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r"); stdin.write("fresh draft"); stdin.write("\u001b[A"); stdin.write("X"); stdin.write("\u001b[B"); stdin.write("Y");
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("Xfresh draftY");
    expect(composer).not.toContain("/helpY");
  });

  it("routes Kitty editing shortcuts without leaking their character codepoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    const ctrl = (codepoint: number) => { stdin.write(`\u001b[${codepoint};5u`); stdin.write(`\u001b[${codepoint};5:3u`); };
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("abc def"); ctrl(97); stdin.write("X"); ctrl(101); ctrl(119); ctrl(117);
    stdin.write("undo"); ctrl(45);
    stdin.write("line1"); ctrl(106); stdin.write("line2"); ctrl(97); stdin.write("X"); ctrl(101);
    await new Promise((resolve) => setTimeout(resolve, 80));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("line1"); expect(composer).toContain("Xline2");
    expect(composer).not.toContain("abc"); expect(composer).not.toContain("undo");
    expect(composer).not.toContain("[97;5"); expect(composer).not.toContain("[106;5");
  });

  it("matches Pi word movement and forward deletion across legacy and Kitty keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("one two");
    stdin.write("\u0001"); // Ctrl+A
    stdin.write("\u001bf"); // Alt+F
    stdin.write("\u0006"); // Ctrl+F
    stdin.write("\u0004"); // Ctrl+D
    stdin.write("\u001b[102;3u"); // Kitty Alt+F
    stdin.write("\u001b[98;3u"); // Kitty Alt+B
    stdin.write("\u001bd"); // Alt+D
    stdin.write("X");
    await new Promise((resolve) => setTimeout(resolve, 70));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("one X");
    expect(composer).not.toContain("two");
    expect(composer).not.toContain("woX");
  });

  it("routes Kitty Ctrl+V to clipboard text fallback and image attachment", async () => {
    let imageAvailable = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/attachments") && method === "POST") return Response.json({ attachment: { id: "image_clipboard", name: "clipboard.png", mediaType: "image/png", size: 4 } });
      return new Response(null, { status: 404 });
    }));
    const clipboard = {
      async readImage() { if (!imageAvailable) throw new Error("no image"); return { name: "clipboard.png", bytes: Buffer.from([137, 80, 78, 71]) }; },
      async readText() { return "clipboard text"; },
    };
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place", clipboard }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[118;5u"); stdin.write("\u001b[118;5:3u"); await new Promise((resolve) => setTimeout(resolve, 40));
    imageAvailable = true; stdin.write("\u001b[118;5u"); stdin.write("\u001b[118;5:3u"); await new Promise((resolve) => setTimeout(resolve, 70));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).toContain("clipboard text"); expect(composer).toContain("clipboard.png"); expect(composer).not.toContain("clipboard textv");
  });

  it("keeps every context-dependent command actionable at an empty Session", async () => {
    let runtime = { revision: 1, maxIterations: 3, planReview: "auto", executionPolicy: { workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "dangerous_only", customRules: [] }, safetyClassifier: { enabled: false, fallback: "use_base_policy" } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/api/runtime")) return new Response(null, { status: 404 });
      if (init?.method === "PUT") { runtime = { ...JSON.parse(String(init.body)), revision: runtime.revision + 1 }; }
      return Response.json(runtime);
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    const command = async (value: string, expected: string) => {
      stdin.write(`${value}\r`); await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stripAnsi(rendered)).toContain(expected);
      stdin.write("\u0015"); await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    await command("/continue", "Usage: /continue MESSAGE");
    await command("/placement", "Usage: /placement in_place|isolated");
    await command("/max-iterations", "Usage: /max-iterations N|default");
    await command("/plan", "Usage: /plan approve");
    await command("/permission", "Usage: /permission approve");
    await command("/apply", "No Session result is available to apply.");
    await command("/discard", "No Session result is available to discard.");
    await command("/result", "No Session result is available.");
    await command("/dequeue", "No queued follow-up is available.");
    await command("/stop", "No Run is active.");
    stdin.write("/placement isolated\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stripAnsi(rendered)).toContain("Project workspace placement: isolated");
    stdin.write("/max-iterations 5\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stripAnsi(rendered)).toContain("Project maximum iterations: 5");
    expect(runtime.maxIterations).toBe(5);
    stdin.write("/permissions\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stripAnsi(rendered)).toContain("Permission policy"); stdin.write("\r");
    stdin.write("/quit\r"); await Promise.race([instance.waitUntilExit(), new Promise((_, reject) => setTimeout(() => reject(new Error("/quit did not exit")), 300))]);
    instance.unmount(); vi.unstubAllGlobals();
  });

  it("expands a stored Session result inside scrollable history without starting an Agent", async () => {
    const session = { id: "session_result", goal: "Add a result page", status: "completed" as const, createdAt: "", updatedAt: "", eventCount: 1, runCount: 1, latestRunId: "run_result", workspacePlacement: "in_place" as const, workspaceAccess: "read_write" as const, deliveryStatus: "live" as const };
    const result = developmentResult({ sessionId: session.id, runId: session.latestRunId, iterations: 1, completed: true, changes: { workspace: "/tmp/project", status: "", diff: "", changedFiles: ["packages/cli/src/ui/result-summary.ts"], deletedFiles: [] }, evidence: [{ id: "test", source: "configured_acceptance", owner: "runharness", runtimeId: "local-command", placement: "host", capability: "command", requirement: "required", status: "passed", blocksCompletion: true, summary: "CLI tests passed", startedAt: "", artifacts: [] }], reviews: [{ reviewer: "grok", decision: "accept", text: "Accepted" }], delivery: { status: "applied" } });
    const events = [{ id: "handoff", sessionId: session.id, runId: session.latestRunId, sequence: 0, timestamp: "", actor: "generator", type: "handoff", payload: { summary: "Added the terminal result surface." } }];
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; requests.push({ url, method });
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith(`/api/sessions/${session.id}`)) return Response.json({ session, result });
      if (url.endsWith(`/api/sessions/${session.id}/attachments`)) return Response.json({ attachments: [] });
      if (url.includes(`/api/sessions/${session.id}/events?`)) return Response.json(events);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    const compact = stripAnsi(rendered);
    expect(compact).toContain("Result · completed · 1 iteration");
    expect(compact).toContain("Next · /continue MESSAGE · /new · /result details");
    stdin.write("/result\r"); await new Promise((resolve) => setTimeout(resolve, 50));
    const opened = stripAnsi(rendered);
    expect(opened).toContain("Implementation");
    expect(opened).toContain("Added the terminal result surface.");
    expect(opened).toContain("packages/cli/src/ui/result-summary.ts");
    expect(opened).toContain("no model call");
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    instance.unmount(); vi.unstubAllGlobals();
  });
  it("starts blank even when the Runtime has historical Sessions", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("/api/runtime")) return Response.json({ modules: {}, maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [{ id: "session_old", goal: "old work", status: "failed" }] });
      return new Response(null, { status: 404 });
    }));
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: terminalStream() as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    instance.unmount(); vi.unstubAllGlobals();
    expect(rendered).toContain("New session");
    expect(rendered).toContain("Resume session");
    expect(requests).toEqual(["http://runtime/api/runtime"]);
  });

  it("persists the project iteration limit and uses it for the next Run", async () => {
    let runtime = { revision: 1, maxIterations: 3, planReview: "auto", executionPolicy: { workspace: { placement: "in_place", access: "read_write", materializeIgnored: [] }, network: "allow_declared", approvalMode: "dangerous_only", customRules: [] }, safetyClassifier: { enabled: false, fallback: "use_base_policy" } };
    let runInput: Record<string, unknown> | undefined;
    const active = { id: "session_new", goal: "new work", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_new" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) {
        if (method === "PUT") runtime = { ...JSON.parse(String(init?.body)), revision: runtime.revision + 1 };
        return Response.json(runtime);
      }
      if (url.endsWith("/api/sessions") && method === "POST") { runInput = JSON.parse(String(init?.body)); return Response.json({ sessionId: active.id, runId: "run_new", status: "running", streamUrl: "/stream" }); }
      if (url.endsWith(`/api/sessions/${active.id}`)) return Response.json({ session: active });
      if (url.endsWith(`/api/sessions/${active.id}/attachments`)) return Response.json({ attachments: [] });
      if (url.includes(`/api/sessions/${active.id}/events?`)) return Response.json([]);
      if (url.includes(`/api/sessions/${active.id}/stream?`)) return new Response("", { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place", initialMaxIterations: 9 }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/max-iterations 7\r"); await new Promise((resolve) => setTimeout(resolve, 70));
    stdin.write("new work\r"); await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(runtime.maxIterations).toBe(7);
    expect(runInput).toMatchObject({ goal: "new work", maxIterations: 7 });
  });

  it("creates a new Session when an initial CLI goal is provided", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; requests.push({ url, method });
      if (url.endsWith("/api/runtime")) return Response.json({ modules: {}, maxIterations: 3 });
      if (url.endsWith("/api/sessions") && method === "POST") return Response.json({ sessionId: "session_new", runId: "run_new", status: "running" });
      if (url.endsWith("/api/sessions/session_new")) return Response.json({ session: { id: "session_new", goal: "new work", status: "completed", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z", eventCount: 0, runCount: 1, latestRunId: "run_new", modules: {} } });
      if (url.endsWith("/api/sessions/session_new/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_new/events?")) return Response.json([]);
      return new Response(null, { status: 404 });
    }));
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "new work", initialMode: "in-place",
    }), { stdin: terminalStream() as unknown as NodeJS.ReadStream, stdout: terminalStream(), debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    expect(requests.filter(({ url, method }) => url === "http://runtime/api/sessions" && method === "POST")).toHaveLength(1);
    expect(requests.some(({ url }) => url.endsWith("/api/snapshot"))).toBe(false);
  });

  it("renders a selected Session as a live conversation with intermediate tools", async () => {
    const longCommand = `/bin/zsh -lc "${"x".repeat(200)}"`;
    const events = [
      { id: "start", sessionId: "session_old", runId: "run_old", sequence: 0, timestamp: "", actor: "system" as const, type: "session_started" as const, payload: { goal: "Fix the unreadable TUI" } },
      { id: "agent", sessionId: "session_old", runId: "run_old", sequence: 1, timestamp: "", actor: "generator" as const, type: "agent_started" as const, payload: { agentId: "codex", model: "gpt-5" } },
      { id: "tool", sessionId: "session_old", runId: "run_old", sequence: 2, timestamp: "", actor: "generator" as const, type: "tool_call" as const, payload: { tool: "shell", summary: longCommand } },
      { id: "done", sessionId: "session_old", runId: "run_old", sequence: 3, timestamp: "", actor: "generator" as const, type: "agent_completed" as const, payload: { durationMs: 2300 } },
      { id: "failed", sessionId: "session_old", runId: "run_old", sequence: 4, timestamp: "", actor: "system" as const, type: "run_failed" as const, payload: { message: "tests failed" } },
    ];
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(Conversation, {
      transcript: buildTranscriptItems(events, 80), events, notice: "", running: false,
    }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    instance.unmount();
    expect(rendered).toContain("Fix the unreadable TUI");
    expect(rendered).toContain("Agent · codex · gpt-5");
    expect(rendered).toContain("shell ·");
    expect(rendered).toContain("Run failed · tests failed");
    // Long shell wrappers are truncated in the activity line.
    expect(rendered).not.toContain(longCommand);
  });

  it("opens and closes tool evidence with Kitty Ctrl+O", async () => {
    const session = { id: "session_tools", goal: "inspect tools", status: "failed", createdAt: "", updatedAt: "", eventCount: 1, runCount: 1 };
    const events = [{ id: "tool", sessionId: session.id, runId: "run_tools", sequence: 0, timestamp: "", actor: "generator", type: "tool_call", payload: { tool: "shell", command: "pnpm test" } }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith(`/api/sessions/${session.id}`)) return Response.json({ session });
      if (url.endsWith(`/api/sessions/${session.id}/attachments`)) return Response.json({ attachments: [] });
      if (url.includes(`/api/sessions/${session.id}/events?`)) return Response.json(events);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("\u001b[111;5u"); stdin.write("\u001b[111;5:3u"); await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stripAnsi(rendered)).toContain("Recent tool evidence");
    stdin.write("\u001b[111;5u"); stdin.write("\u001b[111;5:3u"); await new Promise((resolve) => setTimeout(resolve, 40));
    const latest = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("RunHarness"));
    expect(latest).not.toContain("Recent tool evidence");
    instance.unmount(); vi.unstubAllGlobals();
  });

  it("keeps rapid IME input and Backspace synchronized before React rerenders", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime")
      ? Response.json({ modules: {}, maxIterations: 3 })
      : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(Buffer.from("你好x\u007f"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    const plain = stripAnsi(rendered); const composer = plain.slice(plain.lastIndexOf("╭"));
    expect(composer).toContain("› 你好");
    expect(composer).not.toContain("你好x");
  });

  it("handles an isolated macOS DEL keypress as Backspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime")
      ? Response.json({ modules: {}, maxIterations: 3 })
      : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("abcx");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write(Buffer.from([0x7f]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    const plain = stripAnsi(rendered); const composer = plain.slice(plain.lastIndexOf("╭"));
    expect(composer).toContain("› abc");
    expect(composer).not.toContain("abcx");
  });

  it("submits absolute paths and unknown slash-leading multiline text as an ordinary goal", async () => {
    const goal = "/workspace/project/docs 这个文档符合当前项目吗？\n/workspace/project/examples 这个是历史残留吗？\n// keep this literal line";
    let submitted: Record<string, unknown> | undefined;
    const completed = { id: "session_path", goal, status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, latestRunId: "run_path", workspacePlacement: "in_place", workspaceAccess: "read_write", deliveryStatus: "live" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/sessions") && method === "POST") { submitted = JSON.parse(String(init?.body)); return Response.json({ sessionId: completed.id, runId: completed.latestRunId, status: "running" }); }
      if (url.endsWith(`/api/sessions/${completed.id}`)) return Response.json({ session: completed });
      if (url.endsWith(`/api/sessions/${completed.id}/attachments`)) return Response.json({ attachments: [] });
      if (url.includes(`/api/sessions/${completed.id}/events?`)) return Response.json([]);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(`\u001b[200~${goal}\u001b[201~`); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r"); await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(submitted).toMatchObject({ goal, source: "/tmp/project" });
  });

  it("keeps malformed registered commands out of the ordinary prompt path", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(String(input));
      return String(input).endsWith("/api/runtime") ? Response.json({ maxIterations: 3 }) : new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); stdin.write("/delete-session nope\r"); await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount(); vi.unstubAllGlobals();
    expect(stripAnsi(rendered)).toContain("Invalid /delete-session usage. Type /help.");
    expect(posts).toEqual([]);
  });

  it("restores a Session from the picker without starting a new Run", async () => {
    const sessions = [
      { id: "session_one", goal: "first task", status: "failed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 },
      { id: "session_two", goal: "restore this task", status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 2 },
    ];
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; requests.push({ url, method });
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions });
      if (url.endsWith("/api/sessions/session_two")) return Response.json({ session: sessions[1] });
      if (url.endsWith("/api/sessions/session_two/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_two/events?")) return Response.json([]);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/session\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("restore");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("/session\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stripAnsi(rendered)).toContain("Enter open · Esc/q/Ctrl+C keep current");
    expect(stripAnsi(rendered)).toContain("current");
    stdin.write("q");
    await new Promise((resolve) => setTimeout(resolve, 40));
    instance.unmount(); vi.unstubAllGlobals();
    const plain = stripAnsi(rendered);
    expect(plain).toContain("Restored Session session_two");
    expect(plain).toContain("restore this task");
    expect(requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("closes the Session picker with Ctrl+C instead of exiting RunHarness", async () => {
    const sessions = [
      { id: "session_one", goal: "keep this task", status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/session\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stripAnsi(rendered)).toContain("Esc/q/Ctrl+C keep current");
    stdin.write("\u001b[99;5u"); stdin.write("\u001b[99;5:3u");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/he\t\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const plain = stripAnsi(rendered);
    instance.unmount(); vi.unstubAllGlobals();
    expect(plain.lastIndexOf("RunHarness help")).toBeGreaterThan(plain.lastIndexOf("Choose Session"));
  });

  it("keeps persisted Session images out of the composer while continuing with them", async () => {
    const session = { id: "session_image", goal: "inspect screenshot", status: "failed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 };
    let continued = false;
    let runInput: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_image") && method === "GET") return Response.json({ session: continued ? { ...session, status: "running", activeRunId: "run_next" } : session });
      if (url.endsWith("/api/sessions/session_image/attachments")) return Response.json({ attachments: [{ id: "image_history", name: "submitted.png", mediaType: "image/png", size: 1024 }] });
      if (url.includes("/api/sessions/session_image/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions/session_image/runs") && method === "POST") {
        continued = true; runInput = JSON.parse(String(init?.body));
        return Response.json({ sessionId: "session_image", runId: "run_next", status: "running" });
      }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await openFirstSession(stdin);
    stdin.write("continue with the screenshot\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
    expect(composer).not.toContain("submitted.png");
    expect(runInput).toMatchObject({
      message: "continue with the screenshot",
      attachmentIds: [],
      selectedAttachmentIds: ["image_history"],
    });
  });

  it("starts a fresh Session for ordinary input after a completed Session", async () => {
    const completed = { id: "session_done", goal: "old task", status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 };
    const fresh = { id: "session_fresh", goal: "new task", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_fresh" };
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [completed] });
      if (url.endsWith("/api/sessions/session_done") && method === "GET") return Response.json({ session: completed });
      if (url.endsWith("/api/sessions/session_done/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_done/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions") && method === "POST") {
        requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ sessionId: fresh.id, runId: "run_fresh", status: "running" });
      }
      if (url.endsWith("/api/sessions/session_fresh") && method === "GET") return Response.json({ session: fresh });
      if (url.endsWith("/api/sessions/session_fresh/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_fresh/events?")) return Response.json([]);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await openFirstSession(stdin);
    stdin.write("new task\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(requests).toEqual([{ url: "http://runtime/api/sessions", body: expect.objectContaining({ goal: "new task" }) }]);
  });

  it("accepts an image and queues the follow-up while a Run is active", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runharness-tui-running-"));
    const imagePath = path.join(directory, "live.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
    const session = { id: "session_live", goal: "active task", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_live" };
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (method === "POST") posts.push(url);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_live") && method === "GET") return Response.json({ session });
      if (url.endsWith("/api/sessions/session_live/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_live/events?")) return Response.json([]);
      if (url.includes("/api/sessions/session_live/stream?")) return new Response("event: end\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.endsWith("/api/attachments") && method === "POST") return Response.json({ attachment: { id: "image_live", name: "live.png", mediaType: "image/png", size: 4 } });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: directory, initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await openFirstSession(stdin);
      stdin.write(imagePath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("use this screenshot next\r");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const plain = stripAnsi(rendered);
      expect(plain).toContain("Pending follow-up · 1");
      expect(plain).toContain("use this screenshot next · 1 image");
      expect(posts).toEqual(["http://runtime/api/attachments"]);
      stdin.write("\u001b\u001b[A");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const restored = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
      expect(restored).toContain("use this screenshot next");
      expect(restored).toContain("live.png");
    } finally {
      instance.unmount(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true });
    }
  });

  it("promotes the latest local follow-up with /steer", async () => {
    const session = { id: "session_steer", goal: "active task", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, latestRunId: "run_live", activeRunId: "run_live", workspacePlacement: "in_place", workspaceAccess: "read_write", deliveryStatus: "live" };
    let steerInput: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_steer") && method === "GET") return Response.json({ session });
      if (url.endsWith("/api/sessions/session_steer/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_steer/events?")) return Response.json([]);
      if (url.includes("/api/sessions/session_steer/stream?")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      if (url.endsWith("/api/sessions/session_steer/steer") && method === "POST") { steerInput = JSON.parse(String(init?.body)); return Response.json({ sessionId: session.id, runId: "run_replanned", status: "running" }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("supplement the current requirement\r"); await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("/steer\r"); await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(steerInput).toMatchObject({ message: "supplement the current requirement" });
  });

  it("focuses, navigates, and deletes image attachments with terminal keys", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runharness-images-"));
    const firstPath = path.join(directory, "first.png"); const secondPath = path.join(directory, "second.png");
    await writeFile(firstPath, Buffer.from([137, 80, 78, 71])); await writeFile(secondPath, Buffer.from([137, 80, 78, 71]));
    let upload = 0; const deleted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/attachments") && method === "POST") { upload += 1; return Response.json({ attachment: { id: `image_${upload}`, name: upload === 1 ? "first.png" : "second.png", mediaType: "image/png", size: 4 } }); }
      if (url.includes("/api/attachments/image_") && method === "DELETE") { deleted.push(url); return new Response(null, { status: 204 }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: directory, initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.write(`${firstPath} ${secondPath}`); await new Promise((resolve) => setTimeout(resolve, 120));
      stdin.write("\t"); stdin.write("\u001b[C"); stdin.write("\u001b[3~"); await new Promise((resolve) => setTimeout(resolve, 80));
      const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
      expect(composer).toContain("first.png"); expect(composer).not.toContain("second.png");
      expect(deleted).toEqual(["http://runtime/api/attachments/image_2"]);
    } finally { instance.unmount(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
  });

  it("clears draft images once the Run starts even when the follow-up refresh fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runharness-tui-"));
    const imagePath = path.join(directory, "draft.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
    let startInput: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/attachments") && method === "POST") return Response.json({ attachment: { id: "image_draft", name: "draft.png", mediaType: "image/png", size: 4 } });
      if (url.endsWith("/api/sessions") && method === "POST") { startInput = JSON.parse(String(init?.body)); return Response.json({ sessionId: "session_image", runId: "run_image", status: "running" }); }
      if (url.includes("/api/sessions/session_image")) return Response.json({ error: "refresh unavailable" }, { status: 503 });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: directory, initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.write(imagePath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stripAnsi(rendered)).toContain("draft.png");
      stdin.write("fix the flow\r");
      await new Promise((resolve) => setTimeout(resolve, 140));
      const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
      expect(composer).not.toContain("draft.png");
      expect(startInput).toMatchObject({ goal: "fix the flow", attachmentIds: ["image_draft"] });
      expect(stripAnsi(rendered)).toContain("Run started, but its latest state could not be refreshed");
    } finally {
      instance.unmount(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps draft images when creating the Run fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "runharness-tui-"));
    const imagePath = path.join(directory, "retry.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/attachments") && method === "POST") return Response.json({ attachment: { id: "image_retry", name: "retry.png", mediaType: "image/png", size: 4 } });
      if (url.endsWith("/api/sessions") && method === "POST") return Response.json({ error: "could not start" }, { status: 500 });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: directory, initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.write(imagePath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("retry later\r");
      await new Promise((resolve) => setTimeout(resolve, 120));
      const composer = stripAnsi(rendered).slice(stripAnsi(rendered).lastIndexOf("╭"));
      expect(composer).toContain("retry.png");
      expect(stripAnsi(rendered)).toContain("could not start");
    } finally {
      instance.unmount(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true });
    }
  });

  it("approves the durable Plan version from the waiting surface", async () => {
    let decision: unknown;
    const session = { id: "session_plan", goal: "implement safely", status: "waiting_for_plan_approval", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_plan" };
    const result = developmentResult({
      sessionId: session.id,
      runId: "run_plan",
      plan: { version: 3, text: "Inspect, implement, verify", status: "proposed", createdAt: "", updatedAt: "" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_plan") && !init?.method) return Response.json({ session, result });
      if (url.endsWith("/api/sessions/session_plan/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_plan/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions/session_plan/plan") && init?.method === "POST") { decision = JSON.parse(String(init.body)); return Response.json({ accepted: true }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await openFirstSession(stdin);
    expect(stripAnsi(rendered)).toContain("Plan v3 · waiting for approval");
    stdin.write("/plan approve\r");
    await new Promise((resolve) => setTimeout(resolve, 80));
    instance.unmount(); vi.unstubAllGlobals();
    expect(decision).toEqual({ version: 3, decision: "approve" });
  });

  it("approves a durable permission request with the selected scope", async () => {
    let decision: unknown;
    const session = { id: "session_permission", goal: "inspect browser", status: "waiting_for_permission", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run_permission" };
    const result = developmentResult({
      sessionId: session.id,
      runId: "run_permission",
      pendingApproval: {
        id: "approval_7", sessionId: session.id, runId: "run_permission",
        action: { kind: "mcp", summary: "Open external account settings", server: "playwright", tool: "browser_navigate" },
        baseDecision: { decision: "ask", source: "builtin", reason: "External account action needs review." },
        status: "pending", createdAt: "",
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_permission") && !init?.method) return Response.json({ session, result });
      if (url.endsWith("/api/sessions/session_permission/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_permission/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions/session_permission/permissions") && init?.method === "POST") { decision = JSON.parse(String(init.body)); return Response.json({ accepted: true }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await openFirstSession(stdin);
    expect(stripAnsi(rendered)).toContain("Permission required");
    stdin.write("/permission approve session\r");
    await new Promise((resolve) => setTimeout(resolve, 80));
    instance.unmount(); vi.unstubAllGlobals();
    expect(decision).toEqual({ requestId: "approval_7", decision: "approve", scope: "session" });
  });

  it("continues only a terminal Session and sends the explicit follow-up", async () => {
    let status = "completed"; let runInput: unknown;
    const selected = () => ({ id: "session_done", goal: "finished task", status, createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [selected()] });
      if (url.endsWith("/api/sessions/session_done") && method === "GET") return Response.json({ session: selected() });
      if (url.endsWith("/api/sessions/session_done/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_done/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions/session_done/runs") && method === "POST") {
        runInput = JSON.parse(String(init?.body)); status = "running";
        return Response.json({ sessionId: "session_done", runId: "run_2", status: "running" });
      }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("/continue tighten verification\r"); await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(runInput).toMatchObject({ message: "tighten verification", maxIterations: 3 });
    expect(stripAnsi(rendered)).toContain("Run run_2 is continuing Session session_done");
  });

  it("creates a linked Session when continuing after isolated delivery", async () => {
    const parent = { id: "session_applied", goal: "delivered task", status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, latestRunId: "run_1", workspacePlacement: "isolated", workspaceAccess: "read_write", deliveryStatus: "applied" };
    const result = developmentResult({ sessionId: parent.id, placement: "isolated", delivery: { status: "applied" } });
    let createInput: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [parent] });
      if (url.endsWith(`/api/sessions/${parent.id}`) && method === "GET") return Response.json({ session: parent, result });
      if (url.endsWith(`/api/sessions/${parent.id}/attachments`)) return Response.json({ attachments: [] });
      if (url.includes(`/api/sessions/${parent.id}/events?`)) return Response.json([]);
      if (url.endsWith("/api/sessions") && method === "POST") { createInput = JSON.parse(String(init?.body)); return Response.json({ sessionId: "session_linked", runId: "run_linked", status: "running" }); }
      if (url.endsWith("/api/sessions/session_linked")) return Response.json({ session: { ...parent, id: "session_linked", parentSessionId: parent.id, status: "running", activeRunId: "run_linked", deliveryStatus: "pending" } });
      if (url.endsWith("/api/sessions/session_linked/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_linked/events?")) return Response.json([]);
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("/continue refine delivered result\r"); await new Promise((resolve) => setTimeout(resolve, 100));
    instance.unmount(); vi.unstubAllGlobals();
    expect(createInput).toMatchObject({ goal: "refine delivered result", parentSessionId: parent.id, placement: "isolated" });
  });

  it("dispatches revise and reject review decisions with exact command boundaries", async () => {
    const decisions: unknown[] = [];
    const session = { id: "session_plan", goal: "review plan", status: "waiting_for_plan_approval", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 };
    const result = developmentResult({ sessionId: session.id, plan: { version: 4, text: "draft", status: "proposed", createdAt: "", updatedAt: "" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_plan") && !init?.method) return Response.json({ session, result });
      if (url.endsWith("/api/sessions/session_plan/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_plan/events?")) return Response.json([]);
      if (url.endsWith("/api/sessions/session_plan/plan") && init?.method === "POST") { decisions.push(JSON.parse(String(init.body))); return Response.json({ accepted: true }); }
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("/plan rejection typo\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u0015/plan revise inspect then test\r"); await new Promise((resolve) => setTimeout(resolve, 70));
    stdin.write("/plan reject missing evidence\r"); await new Promise((resolve) => setTimeout(resolve, 70));
    instance.unmount(); vi.unstubAllGlobals();
    expect(decisions).toEqual([
      { version: 4, decision: "revise", revisedPlan: "inspect then test" },
      { version: 4, decision: "reject", reason: "missing evidence" },
    ]);
  });

  it("applies an isolated result and deletes the reviewed Session with one confirmation Enter", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const session = { id: "session_result", goal: "isolated result", status: "completed", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1 };
    const result = developmentResult({ sessionId: session.id, placement: "isolated" });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) return Response.json({ sessions: [session] });
      if (url.endsWith("/api/sessions/session_result") && method === "GET") return Response.json({ session, result });
      if (url.endsWith("/api/sessions/session_result/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_result/events?")) return Response.json([]);
      if (method !== "GET") calls.push({ url, method, ...(body ? { body } : {}) });
      if (url.endsWith("/result")) return Response.json({ action: "applied", files: ["a.ts"] });
      if (url.endsWith("/api/sessions/session_result") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream();
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "isolated" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("/apply\r"); await new Promise((resolve) => setTimeout(resolve, 70));
    stdin.write("/delete-session\r"); await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write("\r"); await new Promise((resolve) => setTimeout(resolve, 70));
    instance.unmount(); vi.unstubAllGlobals();
    expect(calls).toEqual([
      { url: "http://runtime/api/sessions/session_result/result", method: "POST", body: { action: "apply" } },
      { url: "http://runtime/api/sessions/session_result", method: "DELETE" },
    ]);
  });

  it("keeps Session switching and reset unavailable while a Run is active", async () => {
    let snapshotReads = 0;
    const session = { id: "session_live", goal: "active", status: "running", createdAt: "", updatedAt: "", eventCount: 0, runCount: 1, activeRunId: "run" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) return Response.json({ maxIterations: 3 });
      if (url.endsWith("/api/snapshot")) { snapshotReads += 1; return Response.json({ sessions: [session] }); }
      if (url.endsWith("/api/sessions/session_live")) return Response.json({ session });
      if (url.endsWith("/api/sessions/session_live/attachments")) return Response.json({ attachments: [] });
      if (url.includes("/api/sessions/session_live/events?")) return Response.json([]);
      if (url.includes("/api/sessions/session_live/stream?")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 404 });
    }));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, { baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place" }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 30)); await openFirstSession(stdin);
    stdin.write("/session\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u0015/new\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u0015/quit\r"); await new Promise((resolve) => setTimeout(resolve, 30));
    instance.unmount(); vi.unstubAllGlobals();
    expect(snapshotReads).toBe(1);
    expect(stripAnsi(rendered)).toContain("Stop the active Run before switching Sessions.");
    expect(stripAnsi(rendered)).toContain("Stop the active Run before leaving this Session.");
    expect(stripAnsi(rendered)).toContain("Stop the active Run before quitting RunHarness.");
  });
});

function developmentResult(overrides: Record<string, unknown>) {
  return {
    sessionId: "session", runId: "run", workspace: "/tmp/project", placement: "in_place", iterations: 0, completed: false,
    baselineCommit: "baseline", baselineRepository: "/tmp/runtime.git", sourceRoot: "/tmp/project",
    changes: { workspace: "/tmp/project", status: "", diff: "", changedFiles: [], deletedFiles: [] },
    evidence: [], reviews: [], delivery: { status: "pending" }, ...overrides,
  };
}

describe("TUI conversation presentation", () => {
  it("keeps a visible gap between narrow result markers and commands", async () => {
    const stdout = terminalStream(); stdout.columns = 50; let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(Conversation, { transcript: [{ id: "action", kind: "result", tone: "accent", text: "/continue MESSAGE · refine" }], events: [], notice: "", running: false }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20)); instance.unmount();
    expect(stripAnsi(rendered)).toContain("• /continue MESSAGE");
  });

  it("renders compact and detailed results as ordinary reflowable transcript rows", () => {
    const session = { id: "session", goal: "结果页", status: "completed" as const, createdAt: "", updatedAt: "", eventCount: 1, runCount: 1, latestRunId: "run", workspacePlacement: "in_place" as const, workspaceAccess: "read_write" as const, deliveryStatus: "live" as const };
    const result = developmentResult({ iterations: 1, completed: true, changes: { workspace: "/tmp/project", status: "", diff: "", changedFiles: ["中文路径/结果.ts"], deletedFiles: [] }, evidence: [{ id: "check", source: "configured_acceptance", owner: "runharness", runtimeId: "local-command", placement: "host", capability: "command", requirement: "required", status: "passed", blocksCompletion: true, summary: "中文测试通过", startedAt: "", artifacts: [] }], reviews: [{ reviewer: "grok", decision: "accept", text: "复核通过" }], delivery: { status: "applied" } }) as DevelopmentRunResult;
    const events = [{ id: "handoff", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "generator" as const, type: "handoff" as const, payload: { summary: "实现了可以随终端宽度重新换行的中文结果输出。" } }];
    const summary = buildTuiResultSummary(session, result, events);
    const compact = buildResultTranscriptItems(summary, false);
    const detailed = buildResultTranscriptItems(summary, true);
    expect(compact.map((item) => item.kind)).toEqual(["stage", "activity", "result", "activity", "result"]);
    expect(compact.map((item) => item.text).join("\n")).toContain("中文结果输出");
    expect(detailed.map((item) => item.text)).toContain("中文路径/结果.ts");
    expect(detailed.map((item) => item.text).join("\n")).toContain("中文测试通过");
    expect(fitTranscriptItems(detailed, 8, 40).at(-1)?.text).toBe("Stored Runtime data only · no model call");
  });

  it("shows the latest Run input and does not use a previous stopped Run as the live status", () => {
    const events = [
      { id: "session", sessionId: "session", runId: "run-old", sequence: 0, timestamp: "2026-07-16T00:00:00.000Z", actor: "system" as const, type: "session_started" as const, payload: { goal: "Original goal" } },
      { id: "old-start", sessionId: "session", runId: "run-old", sequence: 1, timestamp: "2026-07-16T00:00:01.000Z", actor: "system" as const, type: "run_started" as const, payload: { goal: "Original goal", userInput: "Original goal" } },
      { id: "old-stop", sessionId: "session", runId: "run-old", sequence: 2, timestamp: "2026-07-16T00:00:02.000Z", actor: "system" as const, type: "run_stopped" as const, payload: {} },
      { id: "new-start", sessionId: "session", runId: "run-new", sequence: 3, timestamp: new Date().toISOString(), actor: "system" as const, type: "run_started" as const, payload: { goal: "Original goal", userInput: "继续", maxIterations: 3 } },
    ];
    const session = { id: "session", goal: "Original goal", status: "running" as const, createdAt: "", updatedAt: "", eventCount: 4, runCount: 2, latestRunId: "run-new", activeRunId: "run-new", workspacePlacement: "in_place" as const, workspaceAccess: "read_write" as const, deliveryStatus: "live" as const };
    const texts = buildTranscriptItems(events, 80).map((item) => item.text);
    expect(texts.filter((text) => text === "Original goal")).toHaveLength(1);
    expect(texts).toContain("继续");
    expect(sessionStatusBar(events, session)).toContain("2 runs · preparing");
    expect(sessionStatusBar(events, session)).not.toContain("run stopped");
  });

  it("turns raw events into a live stage timeline with intermediate tool activity", () => {
    const events = [
      { id: "start", sessionId: "session", runId: "run", sequence: 0, timestamp: "", actor: "system" as const, type: "session_started" as const, payload: { goal: "A long user goal", attachments: [{ id: "image" }] } },
      { id: "agent", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "generator" as const, type: "agent_started" as const, payload: { agentId: "codex", model: "gpt-5" } },
      { id: "tool", sessionId: "session", runId: "run", sequence: 2, timestamp: "", actor: "generator" as const, type: "tool_call" as const, payload: { tool: "shell", summary: "pnpm test" } },
      { id: "done", sessionId: "session", runId: "run", sequence: 3, timestamp: "", actor: "generator" as const, type: "agent_completed" as const, payload: { agentId: "codex", backend: "codex", model: "gpt-5", durationMs: 2300 } },
      { id: "failed", sessionId: "session", runId: "run", sequence: 4, timestamp: "", actor: "system" as const, type: "run_failed" as const, payload: { message: "tests failed" } },
    ];
    const items = buildTranscriptItems(events, 80);
    expect(items.map((item) => item.text)).toEqual([
      "A long user goal  [1 image]",
      "Agent · codex · gpt-5",
      "shell · pnpm test",
      "1 action · latest: shell · pnpm test · 2s · codex · gpt-5",
      "Run failed · tests failed",
    ]);
  });

  it("shows Agents with Iteration and models without exposing fixed pipeline roles", () => {
    const events = [
      { id: "start", sessionId: "session", runId: "run", sequence: 0, timestamp: "", actor: "system" as const, type: "session_started" as const, payload: { goal: "Ship computer use safely" } },
      { id: "planner", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "planner" as const, type: "agent_started" as const, payload: { agentId: "grok", backend: "grok", model: "grok-4.5" } },
      { id: "think", sessionId: "session", runId: "run", sequence: 2, timestamp: "", actor: "planner" as const, type: "message" as const, payload: { phase: "thinking", summary: "Need gated computer-use tools", backend: "grok", model: "grok-4.5" } },
      { id: "plan-done", sessionId: "session", runId: "run", sequence: 3, timestamp: "", actor: "planner" as const, type: "agent_completed" as const, payload: { agentId: "grok", backend: "grok", model: "grok-4.5", durationMs: 12000 } },
      { id: "iter", sessionId: "session", runId: "run", sequence: 4, timestamp: "", actor: "system" as const, type: "iteration_started" as const, payload: { iteration: 1, maxIterations: 3 } },
      { id: "gen", sessionId: "session", runId: "run", sequence: 5, timestamp: "", actor: "generator" as const, type: "agent_started" as const, payload: { agentId: "codex", backend: "codex", iteration: 1 } },
      { id: "tool", sessionId: "session", runId: "run", sequence: 6, timestamp: "", actor: "generator" as const, type: "tool_call" as const, payload: { tool: "shell", summary: "pnpm test", backend: "codex", iteration: 1 } },
      { id: "gen-done", sessionId: "session", runId: "run", sequence: 7, timestamp: "", actor: "generator" as const, type: "agent_completed" as const, payload: { agentId: "codex", backend: "codex", iteration: 1, durationMs: 1000 } },
      { id: "review", sessionId: "session", runId: "run", sequence: 8, timestamp: "", actor: "evaluator" as const, type: "agent_started" as const, payload: { agentId: "claude", backend: "claude", model: "sonnet", iteration: 1 } },
      { id: "draft", sessionId: "session", runId: "run", sequence: 9, timestamp: "", actor: "evaluator" as const, type: "message" as const, payload: { phase: "text", summary: "Checks miss the permission boundary", backend: "claude", model: "sonnet", iteration: 1 } },
      { id: "review-done", sessionId: "session", runId: "run", sequence: 10, timestamp: "", actor: "evaluator" as const, type: "agent_completed" as const, payload: { agentId: "claude", backend: "claude", model: "sonnet", iteration: 1, durationMs: 1000 } },
    ];
    const texts = buildTranscriptItems(events, 100).map((item) => item.text);
    expect(texts).toContain("Agent · grok · grok-4.5");
    expect(texts).toContain("thinking · Need gated computer-use tools");
    expect(texts).toContain("latest: thinking · Need gated computer-use tools · 12s · grok · grok-4.5");
    expect(texts).toContain("Iteration 1/3");
    expect(texts).toContain("Agent · iteration 1 · codex");
    expect(texts).toContain("shell · pnpm test");
    expect(texts).toContain("1 action · latest: shell · pnpm test · 1s · codex");
    expect(texts).toContain("Agent · iteration 1 · claude · sonnet");
    expect(texts).toContain("draft · Checks miss the permission boundary");
    expect(texts).toContain("latest: draft · Checks miss the permission boundary · 1s · claude · sonnet");
  });

  it("keeps the exact Agent failure before the fallback Agent starts", () => {
    const reason = "grok exited with 1: Error: Internal error: {\n  \"message\": \"API error (status 503 Service Unavailable): Connection refused\\nRequest URL: https://cli-chat-proxy.grok.com/v1/responses\",\n  \"http_status\": 503\n}";
    const events = [
      { id: "grok-start", sessionId: "session", runId: "run", sequence: 0, timestamp: "", actor: "planner" as const, type: "agent_started" as const, payload: { agentId: "grok", backend: "grok" } },
      { id: "grok-failed", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "planner" as const, type: "agent_failed" as const, payload: { agentId: "grok", backend: "grok", summary: reason } },
      { id: "codex-start", sessionId: "session", runId: "run", sequence: 2, timestamp: "", actor: "planner" as const, type: "agent_started" as const, payload: { agentId: "codex", backend: "codex" } },
    ];
    const items = buildTranscriptItems(events, 80);
    expect(items.map((item) => item.text)).toEqual([
      "Agent · grok",
      `Agent · grok failed\n${reason}`,
      "Agent · codex",
    ]);
    expect(toolDetailLines(events, 80)).toContain(`Agent · grok failed\n${reason}`);
  });

  it("replaces cumulative stream snapshots and colors accepted reviews as success", () => {
    const events = [
      { id: "agent", sessionId: "session", runId: "run", sequence: 0, timestamp: "", actor: "evaluator" as const, type: "agent_started" as const, payload: { agentId: "grok", model: "grok-4.5", iteration: 1 } },
      { id: "one", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "evaluator" as const, type: "message" as const, payload: { phase: "thinking", summary: "The" } },
      { id: "two", sessionId: "session", runId: "run", sequence: 2, timestamp: "", actor: "evaluator" as const, type: "message" as const, payload: { phase: "thinking", summary: "The user asked for a review" } },
      { id: "draft-one", sessionId: "session", runId: "run", sequence: 3, timestamp: "", actor: "evaluator" as const, type: "message" as const, payload: { phase: "text", summary: "Review" } },
      { id: "draft-two", sessionId: "session", runId: "run", sequence: 4, timestamp: "", actor: "evaluator" as const, type: "message" as const, payload: { phase: "text", summary: "Review accepted" } },
      { id: "verdict", sessionId: "session", runId: "run", sequence: 5, timestamp: "", actor: "evaluator" as const, type: "verdict" as const, payload: { reviewer: "grok:grok-4.5", decision: "accept", text: "## Accepted" } },
    ];
    const items = buildTranscriptItems(events, 100);
    expect(items.filter((item) => item.text.startsWith("thinking ·"))).toEqual([expect.objectContaining({ text: "thinking · The user asked for a review" })]);
    expect(items.filter((item) => item.text.startsWith("draft ·"))).toEqual([expect.objectContaining({ text: "draft · Review accepted" })]);
    expect(items.find((item) => item.text.startsWith("Review ·"))).toMatchObject({ tone: "good" });
  });

  it("humanizes a cancelled legacy stream dump in handoff summaries", async () => {
    const { humanizeDisplayText } = await import("../ui/tui.js");
    const dump = '{"type":"thought","data":"The"}\n{"type":"thought","data":" user"}\n{"type":"end","stopReason":"Cancelled"}';
    expect(humanizeDisplayText(dump)).toBe("The user");
    const events = [
      { id: "plan", sessionId: "session", runId: "run", sequence: 0, timestamp: "", actor: "planner" as const, type: "handoff" as const, payload: { plan: dump } },
    ];
    expect(buildTranscriptItems(events, 80)[0]?.text).toBe("The user");
  });

  it("keeps the latest user message visible while fitting wrapped activity to terminal rows", () => {
    const items = [
      { id: "user", kind: "user" as const, text: "Current request" },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, kind: "activity" as const, text: `activity ${index} ${"x".repeat(30)}` })),
    ];
    expect(fitTranscriptItems(items, 6, 32).map((item) => item.id)).toEqual(["user", "item-10", "item-11"]);
  });

  it("keeps detailed command and failure evidence available behind the tool drawer", () => {
    const events = [
      { id: "call", sessionId: "session", runId: "run", sequence: 1, timestamp: "", actor: "generator" as const, type: "tool_call" as const, payload: { tool: "shell", command: "pnpm test" } },
      { id: "result", sessionId: "session", runId: "run", sequence: 2, timestamp: "", actor: "generator" as const, type: "tool_result" as const, payload: { evidence: { id: "evidence", source: "configured_acceptance", owner: "runharness", runtimeId: "local-command", placement: "host", capability: "command", requirement: "required", status: "failed", failureCategory: "permission", blocksCompletion: true, summary: "permission denied", startedAt: "", completedAt: "", artifacts: [], native: { acceptance: { name: "test" } } } } },
    ];
    expect(toolDetailLines(events, 100)).toEqual(["shell · running · pnpm test", "acceptance · test · failed · local-command · permission"]);
  });

  it("reaches both ends of historical transcript navigation without an empty page", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, kind: "activity" as const, text: `activity ${index}` }));
    expect(fitTranscriptItemsAtOffset(items, 4, 80, 0).map((item) => item.id)).toEqual(["item-8", "item-9", "item-10", "item-11"]);
    expect(fitTranscriptItemsAtOffset(items, 4, 80, 11).map((item) => item.id)).toEqual(["item-0"]);
  });
});

describe("TUI event streaming", () => {
  it("loads more than 600 historical events before opening the live stream", async () => {
    const events = Array.from({ length: 601 }, (_, sequence) => ({ id: `event-${sequence}`, sessionId: "session", runId: "run", sequence, timestamp: new Date(sequence).toISOString(), actor: "system" as const, type: "message" as const, payload: {} }));
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)); const offset = Number(url.searchParams.get("offset")); const limit = Number(url.searchParams.get("limit"));
      return new Response(JSON.stringify(events.slice(offset, offset + limit)), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect(await fetchAllSessionEvents("http://runtime", "session", request as typeof fetch)).toHaveLength(601);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("consumes incremental SSE events until the Run ends", async () => {
    const event = { id: "event", sessionId: "session", runId: "run", sequence: 200, timestamp: new Date().toISOString(), actor: "generator", type: "tool_call", payload: { name: "test" } };
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`id: 200\nevent: harness-event\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {"status":"completed"}\n\n`)); controller.close(); } });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const received: string[] = [];
    const opened = vi.fn();
    await streamSessionEvents("http://runtime/stream?offset=200", new AbortController().signal, (item) => received.push(item.id), opened);
    expect(received).toEqual(["event"]);
    expect(opened).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("TUI composer", () => {
  it("suggests discoverable slash commands without matching argument text", () => {
    expect(suggestSlashCommands("/sess").map((item) => item.command)).toEqual(["/session"]);
    expect(suggestSlashCommands("/permission").map((item) => item.command)).toEqual(["/permission", "/permissions"]);
    expect(suggestSlashCommands("/session session_1")).toEqual([]);
    expect(suggestSlashCommands("/workspace/project")).toEqual([]);
    expect(suggestSlashCommands("//literal")).toEqual([]);
    expect(suggestSlashCommands("ordinary goal")).toEqual([]);
  });

  it("keeps the parameter-entry space only for commands that accept parameters", () => {
    expect(slashCommandCompletion(SLASH_COMMANDS.find((item) => item.command === "/max-iterations")!)).toBe("/max-iterations ");
    expect(slashCommandCompletion(SLASH_COMMANDS.find((item) => item.command === "/stop")!)).toBe("/stop");
  });

  it("moves the cursor by complete graphemes for combining marks and ZWJ emoji", () => {
    expect(splitGraphemes("Ame\u0301👩‍💻中")).toEqual(["A", "m", "e\u0301", "👩‍💻", "中"]);
    expect(composerTextParts("e\u0301👩‍💻", 1)).toEqual({ before: "e\u0301", cursor: "👩‍💻", after: "" });
  });

  it("deletes one complete grapheme and keeps cursor geometry aligned", () => {
    expect(deletePreviousGrapheme("你 sdf", 5)).toEqual({ input: "你 sd", cursorIndex: 4 });
    expect(deletePreviousGrapheme("A👩‍💻中", 2)).toEqual({ input: "A中", cursorIndex: 1 });
    expect(deletePreviousGrapheme("保留", 0)).toEqual({ input: "保留", cursorIndex: 0 });
    expect(composerCursorPosition("你好", "你好", 80, 24, false, false)).toEqual({ x: 10, y: 21 });
    expect(composerCursorPosition("e\u0301", "e\u0301", 80, 24, false, false)).toEqual({ x: 7, y: 21 });
    expect(composerCursorPosition("👩‍💻", "👩‍💻", 80, 24, false, false)).toEqual({ x: 8, y: 21 });
    expect(composerCursorPosition("你\n好", "你", 80, 24, true, true)).toEqual({ x: 8, y: 18 });
    expect(composerCursorPosition("a".repeat(70), "a".repeat(70), 80, 24, false, false)).toEqual({ x: 76, y: 21 });
    expect(composerCursorPosition("a".repeat(71), "a".repeat(71), 80, 24, false, false)).toEqual({ x: 7, y: 21 });
    expect(composerCursorPosition("a".repeat(71), "a".repeat(70), 80, 24, false, false)).toEqual({ x: 76, y: 20 });
    expect(composerCursorPosition(`${"a".repeat(72)}end`, "a".repeat(69), 80, 24, false, false)).toEqual({ x: 75, y: 20 });
  });

  it("renders attachments and the empty cursor inside the composer", async () => {
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(output, { columns: 80, rows: 24 });
    let rendered = "";
    output.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(Composer, {
      attachments: [{ id: "image_test", name: "checkout.png", mediaType: "image/png", size: 438_272 }],
      error: "",
      input: "",
      columns: 80,
      rows: 24,
    }), { stdout: output, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    const plain = stripAnsi(rendered);
    expect(plain).toContain("[Image 1 · checkout.png · 428 KB]");
    expect(plain).toContain("╭");
    expect(plain).toMatch(/│ ›\s+│/);
  });

  it("renders grouped help as a readable view at 80 columns", async () => {
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HelpOverview, { columns: 80 }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    const plain = stripAnsi(rendered);
    expect(plain).toContain("RunHarness help");
    expect(plain).toContain("Sessions");
    expect(plain).toContain("/continue");
    expect(plain).toContain("MESSAGE · refi");
    expect(plain).toContain("Review");
    expect(plain).toContain("Keys");
    expect(plain).toContain("Shift+Enter/Ctrl+J newline");
    expect(plain).toContain("Alt+↑ edit queued");
    expect(plain).toContain("Ctrl+C stop/quit");
    expect(plain).not.toContain("PgUp");
    expect(plain).not.toContain("PgDn");
  });

  it("leaves the help view with q", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/runtime")
      ? Response.json({ modules: {}, maxIterations: 3 })
      : new Response(null, { status: 404 })));
    const stdin = terminalStream(); const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const instance = render(React.createElement(HarnessTui, {
      baseUrl: "http://runtime", projectDir: "/tmp/project", initialGoal: "", initialMode: "in-place",
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("/help\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stripAnsi(rendered)).toContain("RunHarness help");
    stdin.write("q");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const plain = stripAnsi(rendered);
    instance.unmount(); vi.unstubAllGlobals();
    expect(plain.lastIndexOf("New session")).toBeGreaterThan(plain.lastIndexOf("RunHarness help"));
  });

  it("keeps command descriptions visible in the compact palette", async () => {
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const suggestions = SLASH_COMMANDS.filter((command) => command.command.startsWith("/sess"));
    const instance = render(React.createElement(CommandPalette, { suggestions, index: 0, columns: 80 }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    const plain = stripAnsi(rendered);
    expect(plain).toContain("› /session");
    expect(plain).toContain("choose a Session");
    expect(plain).toContain("/help all commands");
  });

  it("renders command names separately from parameter hints at 80 columns", async () => {
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const names = new Set(["/max-iterations", "/stop", "/plan", "/permission", "/permissions"]);
    const suggestions = SLASH_COMMANDS.filter((command) => names.has(command.command));
    const instance = render(React.createElement(CommandPalette, { suggestions, index: 0, columns: 80 }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    const plain = stripAnsi(rendered);
    expect(plain).toMatch(/› \/max-iterations\s+N\|default · project Run limit/);
    expect(plain).toMatch(/ {2}\/plan\s+approve\|revise\|reject · decide Plan/);
    expect(plain).toMatch(/ {2}\/permission\s+approve\|reject · decide action/);
    expect(plain).toMatch(/ {2}\/stop\s+interrupt Run/);
    expect(plain).not.toContain("/max-iterations N|default");
    expect(plain).not.toContain("/permission approve|reject");
  });

  it("moves the command palette window with a selection below the first page", async () => {
    const stdout = terminalStream(); let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString(); });
    const index = SLASH_COMMANDS.findIndex((command) => command.command === "/quit");
    const instance = render(React.createElement(CommandPalette, { suggestions: SLASH_COMMANDS, index, columns: 80 }), { stdout, debug: true, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.unmount();
    const plain = stripAnsi(rendered);
    expect(plain).toContain("› /quit");
    expect(plain).toContain(`${index + 1}/${SLASH_COMMANDS.length}`);
    expect(plain).not.toContain("› /session");
  });
});
