import { spawn } from "node:child_process";
import path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useCursor } from "ink";
import stringWidth from "string-width";
import { DEFAULT_MAX_ITERATIONS, eventsForLatestRun, explainSessionState, validateMaxIterations, type ApprovalDecision, type DevelopmentRunResult, type ExplanationTopic, type HarnessEvent, type ImageAttachment, type PlanDecisionRequest, type RuntimeSettings, type SessionRecord, type StartSessionResponse } from "@runharness/shared";
import { resolveProjectRoot } from "@runharness/development";
import { buildServer, findProjectRuntime } from "@runharness/server";
import { installedDashboardDir } from "../runtime/installation.js";
import { DEFAULT_RUNTIME_PORT, startWithRuntimePort } from "../runtime/port.js";
import { readClipboardImage, readClipboardText } from "../terminal/clipboard-image.js";
import { deleteImage, looksLikeImagePathInput, MAX_DRAFT_IMAGES, resolveImagePaths, uploadImage, uploadImageData } from "../terminal/image-input.js";
import { useTerminalInput, type TerminalInputEvent } from "../terminal/input.js";
import { enterTerminalScreen } from "../terminal/screen.js";
import { buildTuiResultSummary, type TuiResultSummary } from "./result-summary.js";

type Mode = "in-place" | "isolated";
type Line = { id: string; actor: string; text: string; tone?: "muted" | "good" | "bad" | "accent" };
type SessionPickerState = { sessions: SessionRecord[]; index: number; query: string };
type PendingInput = { text: string; attachments: ImageAttachment[] };
type ClipboardReader = { readImage(): Promise<{ name: string; bytes: Buffer }>; readText(): Promise<string> };
const SYSTEM_CLIPBOARD: ClipboardReader = { readImage: readClipboardImage, readText: readClipboardText };
const DELETE_CONFIRM_COMMAND = "/delete-session confirm";
const TERMINAL_SESSION_STATUSES = new Set<SessionRecord["status"]>(["completed", "failed", "stopped"]);
export type TranscriptItem = {
  id: string;
  kind: "user" | "stage" | "activity" | "result" | "system";
  text: string;
  tone?: "muted" | "good" | "bad" | "accent";
};

type CommandSection = "Sessions" | "Run" | "Review" | "Results" | "App";
export type SlashCommand = { command: string; parameters?: string; description: string; section: CommandSection };
export const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/session", description: "choose a Session", section: "Sessions" },
  { command: "/new", description: "leave this Session", section: "Sessions" },
  { command: "/continue", parameters: "MESSAGE", description: "refine a result", section: "Sessions" },
  { command: "/delete-session", parameters: "confirm", description: "review then confirm deletion", section: "Sessions" },
  { command: "/placement", parameters: "in_place|isolated", description: "workspace location", section: "Run" },
  { command: "/max-iterations", parameters: "N|default", description: "project Run limit", section: "Run" },
  { command: "/stop", description: "interrupt Run", section: "Run" },
  { command: "/steer", parameters: "[MESSAGE]", description: "checkpoint and replan now", section: "Run" },
  { command: "/dequeue", description: "edit the latest queued follow-up", section: "Run" },
  { command: "/plan", parameters: "approve|revise|reject", description: "decide Plan", section: "Review" },
  { command: "/permission", parameters: "approve|reject", description: "decide action", section: "Review" },
  { command: "/permissions", description: "permission policy", section: "Review" },
  { command: "/apply", description: "apply isolated work", section: "Results" },
  { command: "/discard", description: "discard isolated work", section: "Results" },
  { command: "/result", description: "inspect current result", section: "Results" },
  { command: "/dashboard", description: "open Web controls", section: "Results" },
  { command: "/explain", parameters: "TOPIC", description: "explain current Harness state", section: "App" },
  { command: "/help", description: "commands and keys", section: "App" },
  { command: "/quit", description: "exit RunHarness", section: "App" },
];

export function slashCommandCompletion(command: SlashCommand): string {
  return command.parameters ? `${command.command} ` : command.command;
}

function slashCommandDetail(command: SlashCommand): string {
  return command.parameters ? `${command.parameters} · ${command.description}` : command.description;
}

export async function launchTui(project = process.cwd(), initialGoal = "", openWeb = false, initialMode?: Mode, initialMaxIterations?: number, port?: number): Promise<void> {
  const projectDir = await resolveProjectRoot(project);
  const existing = await findProjectRuntime(projectDir);
  const reusableUrl = existing && await runtimeAvailable(existing.url) ? existing.url : undefined;
  const server = reusableUrl ? undefined : await buildServer({ projectDir, dashboardDir: installedDashboardDir() });
  const environmentPort = process.env.RUNHARNESS_PORT ? Number(process.env.RUNHARNESS_PORT) : undefined;
  const preferredPort = port ?? environmentPort ?? DEFAULT_RUNTIME_PORT;
  if (server) {
    try {
      await startWithRuntimePort(async (candidate) => { await server.listen({ port: candidate, host: "127.0.0.1" }); }, preferredPort, port === undefined && environmentPort === undefined);
    } catch (error) {
      await server.close();
      throw error;
    }
  }
  const address = server?.server.address();
  if (!reusableUrl && (!address || typeof address === "string")) throw new Error("Could not determine local runtime address");
  const baseUrl = reusableUrl ?? `http://127.0.0.1:${(address as { port: number }).port}`;
  if (openWeb) await openBrowser(baseUrl);
  const terminal = enterTerminalScreen();
  let instance: ReturnType<typeof render> | undefined;
  const leaveOnSignal = () => instance?.unmount();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, leaveOnSignal);
  try {
    instance = render(<HarnessTui baseUrl={baseUrl} projectDir={projectDir} initialGoal={initialGoal} initialMode={initialMode ?? "in-place"} modeOverride={initialMode !== undefined} {...(initialMaxIterations ? { initialMaxIterations } : {})} />, { exitOnCtrlC: false });
    await instance.waitUntilExit();
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, leaveOnSignal);
    instance?.unmount();
    terminal.restore();
    await server?.close();
  }
}

async function runtimeAvailable(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/api/runtime`, { signal: AbortSignal.timeout(1_000) })).ok; }
  catch { return false; }
}

/** TUI 主客户端，与 Dashboard 观察并控制同一个项目 Runtime。 */
export function HarnessTui({ baseUrl, projectDir, initialGoal, initialMode, modeOverride = true, initialMaxIterations, clipboard = SYSTEM_CLIPBOARD }: { baseUrl: string; projectDir: string; initialGoal: string; initialMode: Mode; modeOverride?: boolean; initialMaxIterations?: number; clipboard?: ClipboardReader }) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [projectMaxIterations, setProjectMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
  const [projectRuntime, setProjectRuntime] = useState<RuntimeSettings>();
  const [maxIterations, setMaxIterations] = useState<number | undefined>(initialMaxIterations);
  const [input, setInput] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const inputRef = useRef("");
  const cursorIndexRef = useRef(0);
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef(-1);
  const promptHistoryDraftRef = useRef("");
  const undoRef = useRef<Array<{ input: string; cursorIndex: number }>>([]);
  const preferredColumnRef = useRef<number | undefined>(undefined);
  const [composerFocus, setComposerFocus] = useState<"text" | number>("text");
  const composerFocusRef = useRef<"text" | number>("text");
  const [session, setSession] = useState<SessionRecord>();
  const [result, setResult] = useState<DevelopmentRunResult>();
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [notice, setNotice] = useState("Ready. Describe what you want to change.");
  const [history, setHistory] = useState<Line[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [inheritedAttachments, setInheritedAttachments] = useState<ImageAttachment[]>([]);
  const [composerError, setComposerError] = useState("");
  const [observerNotice, setObserverNotice] = useState("");
  const [imageTrustShown, setImageTrustShown] = useState(false);
  const deleteConfirmationRef = useRef<string | undefined>(undefined);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState>();
  const sessionPickerRef = useRef<SessionPickerState | undefined>(undefined);
  const [restoredSessionId, setRestoredSessionId] = useState<string>();
  const [historyOffset, setHistoryOffset] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandIndexRef = useRef(0);
  const [permissionOverlay, setPermissionOverlay] = useState(false);
  const permissionOverlayRef = useRef(false);
  const [helpOverlay, setHelpOverlay] = useState(false);
  const helpOverlayRef = useRef(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [toolDetailsExpanded, setToolDetailsExpanded] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<PendingInput[]>([]);
  const composerBusy = useRef(false);
  const queuedStartBusy = useRef(false);
  const initialStartBusy = useRef(false);
  const stopBusy = useRef(false);
  const deleteBusy = useRef(false);
  const [terminal, setTerminal] = useState({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const running = session?.status === "running" || session?.status === "waiting_for_permission";
  const currentRunEvents = useMemo(() => eventsForLatestRun(events, session?.latestRunId), [events, session?.latestRunId]);
  const inheritedImageCount = session?.status === "completed" ? 0 : inheritedAttachments.length;

  const commitCommandIndex = useCallback((next: number | ((current: number) => number)) => {
    const value = typeof next === "function" ? next(commandIndexRef.current) : next;
    commandIndexRef.current = value;
    setCommandIndex(value);
  }, []);
  const commitDeleteConfirmation = useCallback((sessionId: string | undefined) => {
    deleteConfirmationRef.current = sessionId;
  }, []);
  const commitComposerFocus = useCallback((next: "text" | number | ((current: "text" | number) => "text" | number)) => {
    const value = typeof next === "function" ? next(composerFocusRef.current) : next;
    composerFocusRef.current = value;
    setComposerFocus(value);
  }, []);
  const commitPermissionOverlay = useCallback((visible: boolean) => { permissionOverlayRef.current = visible; setPermissionOverlay(visible); }, []);
  const commitHelpOverlay = useCallback((visible: boolean) => { helpOverlayRef.current = visible; setHelpOverlay(visible); }, []);
  const commitDraft = useCallback((nextInput: string, nextCursor: number) => {
    const cursor = Math.max(0, Math.min(nextCursor, splitGraphemes(nextInput).length));
    if (nextInput !== inputRef.current) commitCommandIndex(0);
    inputRef.current = nextInput;
    cursorIndexRef.current = cursor;
    setInput(nextInput);
    setCursorIndex(cursor);
  }, [commitCommandIndex]);
  const clearDraft = useCallback(() => {
    undoRef.current = [];
    promptHistoryIndexRef.current = -1;
    promptHistoryDraftRef.current = "";
    preferredColumnRef.current = undefined;
    commitDraft("", 0);
  }, [commitDraft]);
  const editDraft = useCallback((nextInput: string, nextCursor: number) => {
    if (nextInput !== inputRef.current) {
      undoRef.current = [...undoRef.current.slice(-99), { input: inputRef.current, cursorIndex: cursorIndexRef.current }];
      promptHistoryIndexRef.current = -1;
      promptHistoryDraftRef.current = "";
    }
    commitDraft(nextInput, nextCursor);
  }, [commitDraft]);
  const undoDraft = useCallback(() => {
    const previous = undoRef.current.pop();
    if (previous) commitDraft(previous.input, previous.cursorIndex);
  }, [commitDraft]);
  const rememberPrompt = useCallback((value: string) => {
    const entries = promptHistoryRef.current;
    if (entries.at(-1) !== value) promptHistoryRef.current = [...entries.slice(-99), value];
    promptHistoryIndexRef.current = -1;
    promptHistoryDraftRef.current = "";
  }, []);
  const browsePromptHistory = useCallback((direction: -1 | 1) => {
    const entries = promptHistoryRef.current;
    if (!entries.length) return;
    if (promptHistoryIndexRef.current === -1) {
      if (direction > 0) return;
      promptHistoryDraftRef.current = inputRef.current;
      promptHistoryIndexRef.current = entries.length - 1;
    } else promptHistoryIndexRef.current = Math.max(-1, Math.min(entries.length - 1, promptHistoryIndexRef.current + direction));
    const next = promptHistoryIndexRef.current === -1 ? promptHistoryDraftRef.current : entries[promptHistoryIndexRef.current] ?? "";
    commitDraft(next, direction < 0 ? 0 : splitGraphemes(next).length);
  }, [commitDraft]);
  const commitSessionPicker = useCallback((next: SessionPickerState | undefined) => {
    sessionPickerRef.current = next;
    setSessionPicker(next);
  }, []);
  const commitCursor = useCallback((nextCursor: number) => {
    const cursor = Math.max(0, Math.min(nextCursor, splitGraphemes(inputRef.current).length));
    cursorIndexRef.current = cursor;
    setCursorIndex(cursor);
  }, []);

  useEffect(() => {
    const resize = () => setTerminal({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on("resize", resize);
    return () => { process.stdout.off("resize", resize); };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch(`${baseUrl}/api/runtime`)
      .then(async (response) => { if (active && response.ok) { const runtime = await response.json() as RuntimeSettings; setProjectMaxIterations(runtime.maxIterations); setProjectRuntime(runtime); if (!modeOverride) setMode(runtime.executionPolicy.workspace.placement === "isolated" ? "isolated" : "in-place"); } })
      .catch(() => undefined);
    return () => { active = false; };
  }, [baseUrl, modeOverride]);

  const addLine = useCallback((actor: string, text: string, tone?: Line["tone"]) => {
    setHistory((current) => [...current.slice(-8), { id: `${Date.now()}-${Math.random()}`, actor, text, ...(tone ? { tone } : {}) }]);
  }, []);

  const saveProjectMaxIterations = useCallback(async (value: number) => {
    try {
      const currentResponse = await fetch(`${baseUrl}/api/runtime`);
      if (!currentResponse.ok) throw new Error(`Could not load project Runtime settings (${currentResponse.status})`);
      const current = await currentResponse.json() as RuntimeSettings;
      const response = await fetch(`${baseUrl}/api/runtime`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...current, maxIterations: value }),
      });
      const body = await response.json() as RuntimeSettings & { error?: string; current?: RuntimeSettings };
      if (!response.ok) {
        if (body.current) {
          setProjectRuntime(body.current);
          setProjectMaxIterations(body.current.maxIterations);
        }
        throw new Error(body.error ?? `Could not save project Runtime settings (${response.status})`);
      }
      setProjectRuntime(body);
      setProjectMaxIterations(body.maxIterations);
      // 显式项目设置必须立即生效，即使本次 TUI 启动时带有仅对当前进程有效的 CLI 覆盖值。
      setMaxIterations(undefined);
      addLine("system", `Project maximum iterations: ${body.maxIterations}`, "good");
    } catch (error) {
      addLine("system", error instanceof Error ? error.message : String(error), "bad");
    }
  }, [addLine, baseUrl]);

  const saveWorkspacePlacement = useCallback(async (nextMode: Mode) => {
    try {
      const currentResponse = await fetch(`${baseUrl}/api/runtime`);
      if (!currentResponse.ok) throw new Error(`Could not load project Runtime settings (${currentResponse.status})`);
      const current = await currentResponse.json() as RuntimeSettings;
      const response = await fetch(`${baseUrl}/api/runtime`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...current, executionPolicy: { ...current.executionPolicy, workspace: { ...current.executionPolicy.workspace, placement: nextMode === "isolated" ? "isolated" : "in_place" } } }) });
      const saved = await response.json() as RuntimeSettings & { error?: string };
      if (!response.ok) throw new Error(saved.error ?? `Could not save workspace placement (${response.status})`);
      setProjectRuntime(saved); setMode(nextMode); addLine("system", `Project workspace placement: ${nextMode}`, "good");
    } catch (error) { addLine("system", error instanceof Error ? error.message : String(error), "bad"); }
  }, [addLine, baseUrl]);

  const reconcileSession = useCallback(async (id: string) => {
    const detailResponse = await fetch(`${baseUrl}/api/sessions/${id}`);
    if (!detailResponse.ok) throw new Error(`Could not open Session ${id} (${detailResponse.status})`);
    const detail = await detailResponse.json() as { session: SessionRecord; result?: DevelopmentRunResult };
    setSession(detail.session);
    setResult(detail.result);
    return detail.session;
  }, [baseUrl]);

  const refresh = useCallback(async (id: string) => {
    const latest = await reconcileSession(id);
    const [eventResult, attachmentResult] = await Promise.allSettled([
      fetchAllSessionEvents(baseUrl, id),
      fetch(`${baseUrl}/api/sessions/${id}/attachments`),
    ]);
    if (eventResult.status === "fulfilled") setEvents(eventResult.value);
    if (attachmentResult.status === "fulfilled" && attachmentResult.value.ok)
      setInheritedAttachments((await attachmentResult.value.json() as { attachments: ImageAttachment[] }).attachments);
    return latest;
  }, [baseUrl, reconcileSession]);

  const openSession = useCallback(async (id: string) => {
    await refresh(id);
    commitDeleteConfirmation(undefined);
    setHistory([]);
    setPendingInputs([]);
    setHistoryOffset(0);
    setResultExpanded(false);
    setRestoredSessionId(id);
    setNotice(`Restored Session ${id}. Choose what to do next.`);
  }, [commitDeleteConfirmation, refresh]);

  const openSessionPicker = useCallback(async () => {
    const response = await fetch(`${baseUrl}/api/snapshot`);
    if (!response.ok) throw new Error(`Could not list Sessions (${response.status})`);
    const body = await response.json() as { sessions: SessionRecord[] };
    const currentIndex = body.sessions.findIndex((item) => item.id === session?.id);
    commitSessionPicker({ sessions: body.sessions, index: Math.max(0, currentIndex), query: "" });
  }, [baseUrl, commitSessionPicker, session?.id]);

  useEffect(() => {
    if (!session?.id || session.status !== "running") return;
    const controller = new AbortController();
    const sessionId = session.id;
    let offset = events.length;
    const observe = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamSessionEvents(`${baseUrl}/api/sessions/${sessionId}/stream?offset=${offset}`, controller.signal, (event) => {
            offset += 1;
            setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
            const status = event.type === "run_completed" ? "completed" : event.type === "run_failed" ? "failed" : event.type === "run_stopped" ? "stopped" : undefined;
            if (status) setSession((current) => {
              if (current?.id !== sessionId) return current;
              const terminal = { ...current };
              delete terminal.activeRunId;
              return { ...terminal, status };
            });
          }, () => setObserverNotice(""));
        } catch (error) {
          if (controller.signal.aborted) return;
          setObserverNotice(`Live updates interrupted; reconnecting… ${error instanceof Error ? error.message : String(error)}`);
        }
        if (controller.signal.aborted) return;
        try {
          const latest = await reconcileSession(sessionId);
          if (TERMINAL_SESSION_STATUSES.has(latest.status)) { await refresh(sessionId); return; }
        } catch (error) {
          if (!controller.signal.aborted) setObserverNotice(`Runtime unavailable; reconnecting… ${error instanceof Error ? error.message : String(error)}`);
        }
        await abortableDelay(500, controller.signal).catch(() => undefined);
      }
    };
    void observe();
    return () => controller.abort();
  }, [baseUrl, reconcileSession, refresh, session?.id, session?.status]);

  useEffect(() => {
    if (!session?.id || session.status !== "running") return;
    const sessionId = session.id;
    const timer = setInterval(() => {
      void reconcileSession(sessionId).catch(() => undefined);
    }, 1_000);
    return () => clearInterval(timer);
  }, [reconcileSession, session?.id, session?.status]);

  const start = useCallback(async (goal: string, draftImages: ImageAttachment[] = attachments, continueCurrent = session?.status === "failed" || session?.status === "stopped") => {
    setNotice("Starting session...");
    setComposerError("");
    try {
      const linkedAfterDelivery = Boolean(continueCurrent && session && result?.placement === "isolated" && result.delivery.status !== "pending");
      const continuing = Boolean(continueCurrent && !linkedAfterDelivery && session && session.status !== "running" && session.status !== "idle");
      if (!continuing) setEvents([]);
      setResult(undefined);
      setResultExpanded(false);
      const runtimeResponse = await fetch(`${baseUrl}/api/runtime`);
      const runtime = runtimeResponse.ok ? await runtimeResponse.json() as RuntimeSettings : undefined;
      const response = await fetch(continuing ? `${baseUrl}/api/sessions/${session!.id}/runs` : `${baseUrl}/api/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(continuing
          ? { message: goal, maxIterations: maxIterations ?? runtime?.maxIterations ?? projectMaxIterations, attachmentIds: draftImages.map((image) => image.id), selectedAttachmentIds: inheritedAttachments.map((image) => image.id) }
          : { goal, placement: linkedAfterDelivery ? session?.workspacePlacement ?? result?.placement ?? "in_place" : mode === "isolated" ? "isolated" : "in_place", ...(linkedAfterDelivery && session ? { parentSessionId: session.id } : {}), source: projectDir, maxIterations: maxIterations ?? runtime?.maxIterations ?? projectMaxIterations, attachmentIds: draftImages.map((image) => image.id) }),
      });
      const body = await response.json() as StartSessionResponse & { error?: string };
      if (!response.ok) { const message = body.error ?? `HTTP ${response.status}`; setNotice(message); setComposerError(message); addLine("system", message, "bad"); return false; }
      setRestoredSessionId(undefined);
      setHistoryOffset(0);
      const status = body.status;
      if (status === "running") {
        // Runtime 返回运行中的 Run 后已经接管草稿图片。先清空本地草稿再刷新，
        // 避免一次临时 GET 失败导致用户重复提交同一图片。
        setAttachments([]);
        setNotice(continuing ? `Run ${body.runId} is continuing Session ${body.sessionId}` : linkedAfterDelivery ? `Linked Session ${body.sessionId} is continuing from delivered Session ${session!.id}` : `Session ${body.sessionId} is running`);
        try { await refresh(body.sessionId); }
        catch (error) { setComposerError(`Run started, but its latest state could not be refreshed: ${error instanceof Error ? error.message : String(error)}`); }
        return true;
      }
      try { await refresh(body.sessionId); } catch { /* 下方附件错误才是用户可处理的真实原因。 */ }
      const message = `Session ${body.sessionId} failed while attaching images`;
      setNotice(message); setComposerError(message); addLine("system", message, "bad");
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message); setComposerError(message); addLine("system", message, "bad");
      return false;
    }
  }, [addLine, attachments, baseUrl, inheritedAttachments, maxIterations, mode, projectDir, projectMaxIterations, refresh, result, session]);

  useEffect(() => {
    if (!initialGoal || !projectRuntime || initialStartBusy.current) return;
    initialStartBusy.current = true;
    void start(initialGoal);
  }, [initialGoal, projectRuntime, start]);

  const deliver = useCallback(async (action: "apply" | "discard") => {
    if (!session) return;
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await response.json() as { error?: string; files?: string[]; action?: "applied" | "discarded" };
      if (!response.ok) { addLine("system", body.error ?? `Could not ${action}`, "bad"); await refresh(session.id).catch(() => undefined); return; }
      setResult((current) => current ? { ...current, delivery: { status: body.action ?? (action === "apply" ? "applied" : "discarded"), files: body.files ?? [], updatedAt: new Date().toISOString() } } : current);
      addLine("system", action === "apply" ? `Applied ${body.files?.length ?? 0} changed files to the project.` : "Discarded the isolated workspace.", "good");
    } catch (error) { addLine("system", error instanceof Error ? error.message : String(error), "bad"); }
  }, [addLine, baseUrl, refresh, session]);

  const addImages = useCallback(async (rawPath: string) => {
    if (composerBusy.current) { setComposerError("An image is already being attached."); return; }
    composerBusy.current = true;
    setComposerError("");
    const added: ImageAttachment[] = [];
    try {
      const paths = await resolveImagePaths(rawPath, projectDir);
      if (!paths.length) { setComposerError("No supported image found. Use a PNG, JPEG, GIF, or WebP path."); return; }
      if (inheritedImageCount + attachments.length + paths.length > MAX_DRAFT_IMAGES) { setComposerError(`You can attach at most ${MAX_DRAFT_IMAGES} images.`); return; }
      for (const filePath of paths) added.push(await uploadImage(baseUrl, filePath));
      setAttachments((current) => [...current, ...added]);
      if (!imageTrustShown) { addLine("system", "Attached images will be sent to the models configured for this project.", "muted"); setImageTrustShown(true); }
    } catch (error) {
      if (added.length) setAttachments((current) => [...current, ...added]);
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally { composerBusy.current = false; }
  }, [addLine, attachments.length, baseUrl, imageTrustShown, inheritedImageCount, projectDir]);

  const removeImage = useCallback(async (index: number) => {
    const attachment = attachments[index];
    if (!attachment) { setComposerError("Image number was not found."); return; }
    try {
      await deleteImage(baseUrl, attachment.id);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setComposerError("");
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
  }, [attachments, baseUrl]);

  const pasteClipboard = useCallback(async () => {
    if (composerBusy.current) return;
    composerBusy.current = true; setComposerError("");
    try {
      const image = await clipboard.readImage().catch(() => undefined);
      if (image) {
        if (inheritedImageCount + attachments.length >= MAX_DRAFT_IMAGES) throw new Error(`You can attach at most ${MAX_DRAFT_IMAGES} images.`);
        const attached = await uploadImageData(baseUrl, image.name, image.bytes);
        setAttachments((current) => [...current, attached]);
        if (!imageTrustShown) { addLine("system", "Attached images will be sent to the models configured for this project.", "muted"); setImageTrustShown(true); }
      } else {
        const text = await clipboard.readText();
        if (!text) throw new Error("The clipboard does not contain an image or text.");
        const edit = insertComposerText(inputRef.current, cursorIndexRef.current, text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
        editDraft(edit.input, edit.cursorIndex);
      }
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
    finally { composerBusy.current = false; }
  }, [addLine, attachments.length, baseUrl, clipboard, editDraft, imageTrustShown, inheritedImageCount]);

  const stop = useCallback(async () => {
    if (!session || (session.status !== "running" && session.status !== "waiting_for_permission") || stopBusy.current) return;
    stopBusy.current = true;
    setNotice("Stopping session...");
    try {
      const latest = await reconcileSession(session.id);
      if (latest.status !== "running" && latest.status !== "waiting_for_permission") {
        setNotice(`Session is already ${latest.status}.`);
        await refresh(session.id);
        return;
      }
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/stop`, { method: "POST" });
      const body = await response.json() as { error?: string; status?: SessionRecord["status"] };
      if (!response.ok) { setComposerError(body.error ?? "Could not stop session"); return; }
      addLine("system", body.status && body.status !== "stopped" ? `Session was already ${body.status}.` : "Stop requested. Waiting for the active process to exit.", "muted");
      await refresh(session.id);
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
    finally { stopBusy.current = false; }
  }, [addLine, baseUrl, reconcileSession, refresh, session]);

  const steer = useCallback(async (message: string, draftImages: ImageAttachment[]) => {
    if (!session || session.status !== "running") { setComposerError("Steer requires an active Run."); return false; }
    setNotice("Steering current Run…"); setComposerError("");
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/steer`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: globalThis.crypto.randomUUID(), message, attachmentIds: draftImages.map((image) => image.id), selectedAttachmentIds: inheritedAttachments.map((image) => image.id), maxIterations: maxIterations ?? projectMaxIterations }),
      });
      const body = await response.json() as StartSessionResponse & { error?: string };
      if (!response.ok) { setComposerError(body.error ?? `Could not steer (${response.status})`); return false; }
      setAttachments([]); clearDraft(); setNotice(`Run ${body.runId} is replanning with the latest instruction.`);
      await refresh(session.id);
      return true;
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); return false; }
  }, [baseUrl, clearDraft, inheritedAttachments, maxIterations, projectMaxIterations, refresh, session]);

  const quitSafely = useCallback(async () => {
    if (!session || (session.status !== "running" && session.status !== "waiting_for_permission")) { exit(); return; }
    try {
      const latest = await reconcileSession(session.id);
      if (latest.status !== "running" && latest.status !== "waiting_for_permission") { exit(); return; }
      setComposerError("Stop the active Run before quitting RunHarness.");
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
  }, [exit, reconcileSession, session]);

  const decidePlan = useCallback(async (body: PlanDecisionRequest) => {
    if (!session) return;
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const resultBody = await response.json() as { error?: string };
      if (!response.ok) { setComposerError(resultBody.error ?? "Could not update the Plan"); return; }
      clearDraft();
      await refresh(session.id);
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
  }, [baseUrl, clearDraft, refresh, session]);

  const decidePermission = useCallback(async (decision: ApprovalDecision["decision"], scope: ApprovalDecision["scope"], reason?: string) => {
    if (!session || !result?.pendingApproval) return;
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${session.id}/permissions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: result.pendingApproval.id, decision, scope, ...(reason ? { reason } : {}) }) });
      const resultBody = await response.json() as { error?: string };
      if (!response.ok) { setComposerError(resultBody.error ?? "Could not decide the permission request"); return; }
      clearDraft();
      await refresh(session.id);
    } catch (error) { setComposerError(error instanceof Error ? error.message : String(error)); }
  }, [baseUrl, clearDraft, refresh, result?.pendingApproval, session]);

  const restoreLatestPending = useCallback((fromCommand = false) => {
    const latest = pendingInputs.at(-1);
    if (!latest) { setComposerError("No queued follow-up is available."); return false; }
    const currentText = inputRef.current.trim();
    if ((currentText && !(fromCommand && currentText === "/dequeue")) || attachments.length) {
      setComposerError("Submit or clear the current draft before editing a queued follow-up.");
      return false;
    }
    setPendingInputs((current) => current.slice(0, -1));
    setAttachments(latest.attachments);
    commitDraft(latest.text, splitGraphemes(latest.text).length);
    setNotice("Queued follow-up restored for editing.");
    setComposerError("");
    return true;
  }, [attachments.length, commitDraft, pendingInputs]);

  const submit = useCallback((raw: string) => {
    const value = raw.trim(); if (!value) return;
    rememberPrompt(value);
    setComposerError("");
    if (deleteConfirmationRef.current && value !== "/delete-session" && value !== "/delete-session confirm") commitDeleteConfirmation(undefined);
    if (value === "/quit") { void quitSafely(); return; }
    if (value === "/help") { clearDraft(); commitHelpOverlay(true); return; }
    if (value === "/result") { if (!session || !result || !TERMINAL_SESSION_STATUSES.has(session.status)) { setComposerError("No Session result is available."); return; } clearDraft(); setResultExpanded(true); setHistoryOffset(0); setNotice("Showing the stored Session result. No model was called."); return; }
    if (value === "/new") { if (running) { setComposerError("Stop the active Run before leaving this Session."); return; } clearDraft(); commitDeleteConfirmation(undefined); setSession(undefined); setResult(undefined); setResultExpanded(false); setEvents([]); setHistory([]); setInheritedAttachments([]); setPendingInputs([]); setRestoredSessionId(undefined); setHistoryOffset(0); return; }
    if (value === "/stop") { clearDraft(); if (!running) { addLine("system", "No Run is active.", "muted"); return; } void stop(); return; }
    if (value === "/steer") {
      if (!running) { setComposerError("Steer requires an active Run."); return; }
      const latest = pendingInputs.at(-1);
      if (!latest) { setComposerError("Enter /steer MESSAGE or queue a follow-up first."); return; }
      void steer(latest.text, latest.attachments).then((accepted) => { if (accepted) setPendingInputs((current) => current.slice(0, -1)); });
      return;
    }
    if (value.startsWith("/steer ")) {
      if (!running) { setComposerError("Steer requires an active Run."); return; }
      const message = value.slice(7).trim(); if (!message) { setComposerError("Usage: /steer MESSAGE"); return; }
      void steer(message, attachments);
      return;
    }
    if (value === "/dequeue") { restoreLatestPending(true); return; }
    if (value === "/continue") { setComposerError("Usage: /continue MESSAGE"); return; }
    if (value.startsWith("/continue ")) {
      if (!session || !["completed", "failed", "stopped"].includes(session.status)) {
        setComposerError(running ? "Wait for the active Run to end, or submit ordinary input to queue it." : "Open a completed, failed, or stopped Session before continuing it.");
        return;
      }
      const message = value.slice(10).trim();
      if (!message) { setComposerError("Usage: /continue MESSAGE"); return; }
      const draft = attachments;
      void start(message, draft, true).then((started) => { if (started) { clearDraft(); commitComposerFocus("text"); } });
      return;
    }
    if (value.startsWith("/max-iterations ")) {
      clearDraft(); const selected = value.slice(16).trim();
      if (selected === "default") void saveProjectMaxIterations(DEFAULT_MAX_ITERATIONS);
      else { try { void saveProjectMaxIterations(validateMaxIterations(selected)); } catch (error) { addLine("system", error instanceof Error ? error.message : String(error), "bad"); } }
      return;
    }
    if (value === "/max-iterations") { setComposerError("Usage: /max-iterations N|default"); return; }
    if (value.startsWith("/placement ")) { clearDraft(); const next = value.slice(11); if (next === "in_place" || next === "isolated") void saveWorkspacePlacement(next === "in_place" ? "in-place" : "isolated"); else addLine("system", "Placement must be in_place or isolated", "bad"); return; }
    if (value === "/placement") { setComposerError("Usage: /placement in_place|isolated"); return; }
    if (value === "/dashboard") {
      clearDraft();
      void openBrowser(baseUrl)
        .then(() => addLine("system", `Opened ${baseUrl}`, "good"))
        .catch((error) => addLine("system", error instanceof Error ? error.message : String(error), "bad"));
      return;
    }
    if (value === "/explain" || value.startsWith("/explain ")) {
      const selected = value.slice(8).trim() || (result?.placement === "isolated" && result.delivery.status === "pending" ? "delivery" : "workspace");
      if (!["workspace", "delivery", "steer", "permission", "evidence"].includes(selected)) { setComposerError("Usage: /explain workspace|delivery|steer|permission|evidence"); return; }
      clearDraft(); const explanation = explainSessionState(selected as ExplanationTopic, session, result);
      addLine("system", `${explanation.title}\n${explanation.summary}\n\nWhy: ${explanation.why}\nChanges: ${explanation.changes}\nRemains: ${explanation.remains}\nNext: ${explanation.actions.join(" · ")}`, "accent");
      return;
    }
    if (value === "/session") { if (running) { setComposerError("Stop the active Run before switching Sessions."); return; } clearDraft(); void openSessionPicker().catch((error) => setComposerError(error instanceof Error ? error.message : String(error))); return; }
    if (value === "/permissions") { clearDraft(); commitPermissionOverlay(true); return; }
    if (value === "/plan approve") { if (session?.status !== "waiting_for_plan_approval" || result?.plan?.status !== "proposed") { setComposerError("No Plan is waiting for approval."); return; } void decidePlan({ version: result.plan.version, decision: "approve" }); return; }
    if (value === "/plan" || value === "/plan revise") { setComposerError("Usage: /plan approve | /plan revise PLAN | /plan reject REASON"); return; }
    if (value.startsWith("/plan revise ")) { if (session?.status !== "waiting_for_plan_approval" || result?.plan?.status !== "proposed") { setComposerError("No Plan is waiting for revision."); return; } const revisedPlan = value.slice(13).trim(); if (!revisedPlan) { setComposerError("Usage: /plan revise PLAN"); return; } void decidePlan({ version: result.plan.version, decision: "revise", revisedPlan }); return; }
    if (value === "/plan reject" || value.startsWith("/plan reject ")) { if (session?.status !== "waiting_for_plan_approval" || result?.plan?.status !== "proposed") { setComposerError("No Plan is waiting for rejection."); return; } void decidePlan({ version: result.plan.version, decision: "reject", reason: value.slice(12).trim() || "Rejected from TUI" }); return; }
    if (value.startsWith("/permission approve")) { if (session?.status !== "waiting_for_permission" || !result?.pendingApproval) { setComposerError("No permission request is waiting for approval."); return; } const scope = value.split(/\s+/)[2]; if (scope !== "once" && scope !== "session" && scope !== "project") { setComposerError("Usage: /permission approve once|session|project"); return; } void decidePermission("approve", scope); return; }
    if (value === "/permission reject" || value.startsWith("/permission reject ")) { if (session?.status !== "waiting_for_permission" || !result?.pendingApproval) { setComposerError("No permission request is waiting for rejection."); return; } void decidePermission("reject", "once", value.slice(18).trim() || "Rejected from TUI"); return; }
    if (value === "/permission") { setComposerError("Usage: /permission approve once|session|project | /permission reject REASON"); return; }
    if (value === "/delete-session") {
      clearDraft();
      if (!session) { addLine("system", "No Session is selected.", "bad"); return; }
      if (running) { addLine("system", "Stop the active Run before deleting this Session.", "bad"); return; }
      if (deleteConfirmationRef.current === session.id) { commitDraft(DELETE_CONFIRM_COMMAND, splitGraphemes(DELETE_CONFIRM_COMMAND).length); setComposerError("Deletion is already reviewed. Press Enter to confirm, or enter another command to cancel."); return; }
      commitDeleteConfirmation(session.id);
      addLine("system", `Delete ${session.id} · ${shortText(session.goal, 96)}\nThis removes ${inheritedAttachments.length} image(s), all Runs, Memory, evidence, and isolated workspaces. Press Enter with /delete-session confirm to continue.`, "bad");
      commitDraft(DELETE_CONFIRM_COMMAND, splitGraphemes(DELETE_CONFIRM_COMMAND).length);
      return;
    }
    if (value === "/delete-session confirm") {
      clearDraft();
      const id = session?.id;
      if (!id || deleteConfirmationRef.current !== id) { commitDeleteConfirmation(undefined); addLine("system", "Run /delete-session first to review the selected Session.", "bad"); return; }
      if (deleteBusy.current) { setComposerError("Session deletion is already in progress."); return; }
      deleteBusy.current = true;
      void fetch(`${baseUrl}/api/sessions/${id}`, { method: "DELETE" }).then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Could not delete Session");
        commitDeleteConfirmation(undefined); setSession(undefined); setResult(undefined); setEvents([]); setInheritedAttachments([]); setPendingInputs([]); setRestoredSessionId(undefined); setHistoryOffset(0); setNotice("Ready. Describe what you want to change.");
        addLine("system", `Deleted Session ${id} and its Runtime-owned assets.`, "good");
      }).catch((error) => { addLine("system", error instanceof Error ? error.message : String(error), "bad"); commitDraft(DELETE_CONFIRM_COMMAND, splitGraphemes(DELETE_CONFIRM_COMMAND).length); }).finally(() => { deleteBusy.current = false; });
      return;
    }
    if (value === "/apply") { if (!session || !result) { setComposerError("No Session result is available to apply."); return; } if (running) { setComposerError("Stop the active Run before applying a result."); return; } if (result.placement !== "isolated") { setComposerError("In-place work is already in the project and does not need applying."); return; } if (result.delivery.status !== "pending") { setComposerError(`This result is already ${result.delivery.status} and cannot be applied.`); return; } clearDraft(); void deliver("apply"); return; }
    if (value === "/discard") { if (!session || !result) { setComposerError("No Session result is available to discard."); return; } if (running) { setComposerError("Stop the active Run before discarding a result."); return; } if (result.placement !== "isolated") { setComposerError("In-place work cannot be discarded as an isolated workspace."); return; } if (result.delivery.status !== "pending") { setComposerError(`This result is already ${result.delivery.status} and cannot be discarded.`); return; } clearDraft(); void deliver("discard"); return; }
    const slashToken = value.split(/\s+/, 1)[0];
    if (SLASH_COMMANDS.some((command) => command.command === slashToken)) {
      setComposerError(`Invalid ${slashToken} usage. Type /help.`);
      return;
    }
    if (composerBusy.current) { setComposerError("Wait for the image attachment to finish."); return; }
    if (session?.status === "waiting_for_plan_approval") { setComposerError("Review the proposed Plan before continuing."); return; }
    if (session?.status === "waiting_for_permission") { setComposerError("Decide the pending permission request before continuing."); return; }
    if (running) {
      setPendingInputs((current) => [...current, { text: value, attachments }]);
      setAttachments([]);
      clearDraft();
      setNotice("Follow-up queued. It will start automatically after the active Run ends.");
      return;
    }
    const draft = attachments;
    const continueCurrent = session?.status === "failed" || session?.status === "stopped";
    void start(value, draft, continueCurrent).then((started) => { if (started) { clearDraft(); commitComposerFocus("text"); } });
  }, [addLine, attachments, baseUrl, clearDraft, commitComposerFocus, commitDeleteConfirmation, commitDraft, commitHelpOverlay, commitPermissionOverlay, decidePermission, decidePlan, deliver, inheritedAttachments.length, openSessionPicker, pendingInputs, quitSafely, rememberPrompt, restoreLatestPending, result, running, saveProjectMaxIterations, saveWorkspacePlacement, session, start, steer, stop]);

  const composerAttachments = attachments;
  const commandSuggestions = useMemo(() => suggestSlashCommands(input), [input]);
  useEffect(() => {
    if (running || queuedStartBusy.current || !pendingInputs.length || inputRef.current) return;
    if (!session || !["completed", "failed", "stopped"].includes(session.status)) return;
    const [next, ...rest] = pendingInputs;
    if (!next) return;
    queuedStartBusy.current = true;
    setPendingInputs(rest);
    setNotice("Starting queued follow-up...");
    void start(next.text, next.attachments, true).then((started) => {
      if (!started) {
        setAttachments(next.attachments);
        commitDraft(next.text, splitGraphemes(next.text).length);
        setNotice("Queued follow-up could not start. Review it and press Enter to retry.");
      }
    }).finally(() => { queuedStartBusy.current = false; });
  }, [commitDraft, pendingInputs, running, session, start]);
  const transcript = useMemo(() => {
    const eventItems = buildTranscriptItems(events, terminal.columns);
    const commandItems = history.map<TranscriptItem>((line) => ({ id: line.id, kind: "system", text: line.text, ...(line.tone ? { tone: line.tone } : {}) }));
    const resultItems = session && result && TERMINAL_SESSION_STATUSES.has(session.status)
      ? buildResultTranscriptItems(buildTuiResultSummary(session, result, currentRunEvents), resultExpanded, terminal.columns)
      : [];
    const composerRows = 5 + composerAttachments.length + (composerAttachments.length ? 1 : 0) + Math.max(0, composerViewport(input, cursorIndex, Math.max(1, terminal.columns - 10), composerMaxRows(terminal.rows)).visibleRows - 1);
    const paletteRows = commandSuggestions.length ? Math.min(commandSuggestions.length, terminal.columns < 96 ? 5 : 6) + 3 : 0;
    const transcriptRows = Math.max(4, terminal.rows - composerRows - paletteRows - (session ? 3 : 2) - (running ? 2 : 0) - 4);
    return fitTranscriptItemsAtOffset([...eventItems, ...commandItems, ...resultItems], transcriptRows, terminal.columns, historyOffset, resultItems.length === 0);
  }, [commandSuggestions.length, composerAttachments.length, currentRunEvents, cursorIndex, events, history, historyOffset, input, result, resultExpanded, running, session, terminal.columns, terminal.rows]);
  const transcriptItemCount = useMemo(() => {
    const resultItems = session && result && TERMINAL_SESSION_STATUSES.has(session.status)
      ? buildResultTranscriptItems(buildTuiResultSummary(session, result, currentRunEvents), resultExpanded, terminal.columns)
      : [];
    return buildTranscriptItems(events, terminal.columns).length + history.length + resultItems.length;
  }, [currentRunEvents, events, history.length, result, resultExpanded, session, terminal.columns]);
  useEffect(() => { setHistoryOffset((current) => Math.min(current, Math.max(0, transcriptItemCount - 1))); }, [transcriptItemCount]);
  useTerminalInput((event: TerminalInputEvent) => {
    const key = event.type === "key" ? event : undefined;
    const character = event.type === "text" ? event.text : "";
    const controlCharacter = key?.ctrl ? key.character : undefined;
    const activeComposerFocus = composerFocusRef.current;
    const activeCommandSuggestions = suggestSlashCommands(inputRef.current);
    if (controlCharacter === "c") {
      if (sessionPickerRef.current) commitSessionPicker(undefined);
      else if (running && session) void reconcileSession(session.id).then((latest) => latest.status === "running" || latest.status === "waiting_for_permission" ? stop() : exit()).catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
      else exit();
      return;
    }
    const backspace = key?.key === "backspace" || controlCharacter === "h";
    if (helpOverlayRef.current) {
      if (key?.key === "escape" || key?.key === "enter" || character.toLowerCase() === "q") commitHelpOverlay(false);
      return;
    }
    if (permissionOverlayRef.current) { if (key?.key === "escape" || key?.key === "enter") commitPermissionOverlay(false); return; }
    const activeSessionPicker = sessionPickerRef.current;
    if (activeSessionPicker) {
      const visibleSessions = filterSessions(activeSessionPicker.sessions, activeSessionPicker.query);
      if (key?.key === "escape" || character.toLowerCase() === "q") { commitSessionPicker(undefined); return; }
      if (key?.key === "up") { commitSessionPicker({ ...activeSessionPicker, index: Math.max(0, activeSessionPicker.index - 1) }); return; }
      if (key?.key === "down") { commitSessionPicker({ ...activeSessionPicker, index: Math.min(Math.max(0, visibleSessions.length - 1), activeSessionPicker.index + 1) }); return; }
      if (key?.key === "enter") {
        const selected = visibleSessions[activeSessionPicker.index];
        commitSessionPicker(undefined);
        if (selected) void openSession(selected.id).catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (backspace) { commitSessionPicker({ ...activeSessionPicker, query: splitGraphemes(activeSessionPicker.query).slice(0, -1).join(""), index: 0 }); return; }
      if (event.type === "text" && character) { commitSessionPicker({ ...activeSessionPicker, query: activeSessionPicker.query + character, index: 0 }); return; }
      return;
    }
    if (key?.key === "enter" || controlCharacter === "j") {
      if (key?.shift || key?.ctrl || key?.alt) {
        const edit = insertComposerText(inputRef.current, cursorIndexRef.current, "\n");
        editDraft(edit.input, edit.cursorIndex);
      } else submit(inputRef.current);
      return;
    }
    if (controlCharacter === "v") { void pasteClipboard(); return; }
    if (controlCharacter === "o") { setToolDetailsExpanded((current) => !current); return; }
    if (controlCharacter === "-") { undoDraft(); return; }
    if (key?.shift && key.key === "up") { setHistoryOffset((current) => Math.min(Math.max(0, transcriptItemCount - 1), current + Math.max(3, Math.floor(terminal.rows / 3)))); return; }
    if (key?.shift && key.key === "down") { setHistoryOffset((current) => Math.max(0, current - Math.max(3, Math.floor(terminal.rows / 3)))); return; }
    if (key?.alt && key.key === "up" && pendingInputs.length) {
      restoreLatestPending();
      return;
    }
    if (activeComposerFocus === "text" && activeCommandSuggestions.length && key?.key === "up") { commitCommandIndex((current) => (current - 1 + activeCommandSuggestions.length) % activeCommandSuggestions.length); return; }
    if (activeComposerFocus === "text" && activeCommandSuggestions.length && key?.key === "down") { commitCommandIndex((current) => (current + 1) % activeCommandSuggestions.length); return; }
    if (activeComposerFocus === "text" && activeCommandSuggestions.length && key?.key === "tab" && !composerAttachments.length) {
      const selected = activeCommandSuggestions[commandIndexRef.current] ?? activeCommandSuggestions[0];
      if (selected) {
        const completion = slashCommandCompletion(selected);
        commitDraft(completion, splitGraphemes(completion).length);
      }
      return;
    }
    if (key?.key === "escape") { commitComposerFocus("text"); return; }
    if (key?.key === "tab" && composerAttachments.length) {
      commitComposerFocus((current) => {
        if (current === "text") return key.shift ? composerAttachments.length - 1 : 0;
        if (key.shift) return current === 0 ? "text" : current - 1;
        return current === composerAttachments.length - 1 ? "text" : current + 1;
      });
      return;
    }
    if (activeComposerFocus !== "text") {
      if (key?.key === "left") { commitComposerFocus(Math.max(0, activeComposerFocus - 1)); return; }
      if (key?.key === "right") { commitComposerFocus(Math.min(composerAttachments.length - 1, activeComposerFocus + 1)); return; }
      if (backspace || key?.key === "delete") { const removed = activeComposerFocus; void removeImage(removed); commitComposerFocus(composerAttachments.length <= 1 ? "text" : Math.min(removed, composerAttachments.length - 2)); return; }
      return;
    }
    const currentInput = inputRef.current;
    const characters = splitGraphemes(currentInput); const activeCursor = Math.min(cursorIndexRef.current, characters.length);
    if (controlCharacter === "b") { preferredColumnRef.current = undefined; commitCursor(activeCursor - 1); return; }
    if (controlCharacter === "f") { preferredColumnRef.current = undefined; commitCursor(activeCursor + 1); return; }
    if (controlCharacter === "a") { preferredColumnRef.current = undefined; commitCursor(composerLineBoundary(currentInput, activeCursor, "start")); return; }
    if (controlCharacter === "e") { preferredColumnRef.current = undefined; commitCursor(composerLineBoundary(currentInput, activeCursor, "end")); return; }
    if (controlCharacter === "w") {
      const start = composerWordBoundary(currentInput, activeCursor, -1);
      const next = deleteComposerRange(currentInput, start, activeCursor);
      editDraft(next.input, next.cursorIndex); return;
    }
    if (controlCharacter === "u") {
      const start = composerLineBoundary(currentInput, activeCursor, "start");
      const next = deleteComposerRange(currentInput, start, activeCursor);
      editDraft(next.input, next.cursorIndex); return;
    }
    if (controlCharacter === "k") {
      const end = composerLineBoundary(currentInput, activeCursor, "end");
      const next = deleteComposerRange(currentInput, activeCursor, end);
      editDraft(next.input, next.cursorIndex); return;
    }
    if (controlCharacter === "d") {
      const next = deleteNextGrapheme(currentInput, activeCursor);
      editDraft(next.input, next.cursorIndex); return;
    }
    if (key?.alt && key.key === "character" && key.character === "d") {
      const next = deleteComposerRange(currentInput, activeCursor, composerWordBoundary(currentInput, activeCursor, 1));
      editDraft(next.input, next.cursorIndex); return;
    }
    if (key?.alt && key.key === "character" && (key.character === "b" || key.character === "f")) {
      preferredColumnRef.current = undefined;
      commitCursor(composerWordBoundary(currentInput, activeCursor, key.character === "b" ? -1 : 1));
      return;
    }
    if (key?.key === "left") { preferredColumnRef.current = undefined; commitCursor(key.alt || key.ctrl ? composerWordBoundary(currentInput, activeCursor, -1) : activeCursor - 1); return; }
    if (key?.key === "right") { preferredColumnRef.current = undefined; commitCursor(key.alt || key.ctrl ? composerWordBoundary(currentInput, activeCursor, 1) : activeCursor + 1); return; }
    if (key?.key === "up" || key?.key === "down") {
      const direction = key.key === "up" ? -1 : 1;
      const atHistoryBoundary = promptHistoryIndexRef.current !== -1
        && (direction < 0 ? activeCursor === 0 : activeCursor === characters.length);
      if ((!currentInput && direction < 0) || atHistoryBoundary) {
        preferredColumnRef.current = undefined;
        browsePromptHistory(direction);
        return;
      }
      const moved = moveComposerCursorVertical(currentInput, activeCursor, Math.max(1, terminal.columns - 10), direction, preferredColumnRef.current);
      preferredColumnRef.current = moved.preferredColumn;
      commitCursor(moved.cursorIndex);
      return;
    }
    if (key?.key === "home") { preferredColumnRef.current = undefined; commitCursor(composerLineBoundary(currentInput, activeCursor, "start")); return; }
    if (key?.key === "end") { preferredColumnRef.current = undefined; commitCursor(composerLineBoundary(currentInput, activeCursor, "end")); return; }
    if (backspace) {
      const next = key?.alt || key?.ctrl
        ? deleteComposerRange(currentInput, composerWordBoundary(currentInput, activeCursor, -1), activeCursor)
        : deletePreviousGrapheme(currentInput, activeCursor);
      editDraft(next.input, next.cursorIndex);
      return;
    }
    if (key?.key === "delete") {
      const next = key.alt
        ? deleteComposerRange(currentInput, activeCursor, composerWordBoundary(currentInput, activeCursor, 1))
        : deleteNextGrapheme(currentInput, activeCursor);
      editDraft(next.input, next.cursorIndex);
      return;
    }
    if (event.type === "text" && character) {
      if (character.length > 1 && looksLikeImagePathInput(character)) void addImages(character);
      else {
        const edit = insertComposerText(currentInput, activeCursor, character);
        editDraft(edit.input, edit.cursorIndex);
      }
    }
  });

  return <Box flexDirection="column" paddingX={ROOT_PADDING_X} height={Math.max(14, terminal.rows)}>
    <TopBar projectDir={projectDir} session={session} events={events} />
    {helpOverlay ? <HelpOverview columns={terminal.columns} /> : permissionOverlay ? <PermissionOverview runtime={projectRuntime} /> : sessionPicker ? <SessionPicker sessions={sessionPicker.sessions} index={sessionPicker.index} query={sessionPicker.query} {...(session?.id ? { currentSessionId: session.id } : {})} columns={terminal.columns} /> : <>
      {restoredSessionId === session?.id && session && !(result && TERMINAL_SESSION_STATUSES.has(session.status)) && <RecoveryCard session={session} result={result} />}
      {session || transcript.length
        ? <Conversation transcript={transcript} events={currentRunEvents} notice={notice} observerNotice={observerNotice} running={running} />
        : commandSuggestions.length || input || composerAttachments.length ? <Box flexGrow={1} /> : <Welcome columns={terminal.columns} rows={terminal.rows} />}
      <WaitingSurface session={session} result={result} columns={terminal.columns} />
      <PendingInputSurface inputs={pendingInputs} columns={terminal.columns} />
      <ToolDetails events={events} expanded={toolDetailsExpanded} columns={terminal.columns} />
      <CommandPalette suggestions={commandSuggestions} index={commandIndex} columns={terminal.columns} />
      <Composer attachments={composerAttachments} error={composerError} input={input} cursorIndex={cursorIndex} focus={composerFocus} columns={terminal.columns} rows={terminal.rows} />
    </>}
    <Footer mode={mode} maxIterations={maxIterations ?? projectMaxIterations} running={running} baseUrl={baseUrl} columns={terminal.columns} events={currentRunEvents} session={session} historyOffset={historyOffset} />
  </Box>;
}

const ROOT_PADDING_X = 2;

export function Composer({ attachments, error, input, cursorIndex, focus = "text", columns, rows }: {
  attachments: ImageAttachment[];
  error: string;
  input: string;
  cursorIndex?: number;
  focus?: "text" | number;
  columns: number;
  rows: number;
}) {
  const { setCursorPosition } = useCursor();
  const characters = splitGraphemes(input);
  const cursor = Math.min(characters.length, cursorIndex ?? characters.length);
  const viewport = composerViewport(input, cursor, Math.max(1, columns - 10), composerMaxRows(rows));
  const parts = composerTextParts(viewport.text, viewport.cursorIndex);
  const cursorPosition = composerCursorPosition(viewport.text, parts.before, columns, rows, Boolean(error), attachments.length > 0, viewport.linesBelow > 0 ? 1 : 0);
  setCursorPosition(focus === "text" ? cursorPosition : undefined);
  return <Box flexDirection="column" marginTop={1} flexShrink={0}>
    <Box borderStyle="round" borderColor={error ? "red" : "cyan"} paddingX={1} flexDirection="column">
      {attachments.map((attachment, index) => <Text key={attachment.id} color="cyan" inverse={focus === index}>[Image {index + 1} · {truncate(attachment.name, Math.max(12, columns - 30))} · {formatBytes(attachment.size)}]</Text>)}
      {viewport.linesAbove > 0 && <Text dimColor>↑ {viewport.linesAbove} more line{viewport.linesAbove === 1 ? "" : "s"}</Text>}
      <Box>
        <Box width={2} flexShrink={0}><Text bold>› </Text></Box>
        <Box flexGrow={1} flexShrink={1}><Text>{viewport.text}</Text></Box>
      </Box>
      {viewport.linesBelow > 0 && <Text dimColor>↓ {viewport.linesBelow} more line{viewport.linesBelow === 1 ? "" : "s"}</Text>}
    </Box>
    {error && <Text color="red">  {truncateEnd(error, Math.max(12, columns - 4))}</Text>}
    <Text dimColor>  {columns < 80 ? "Enter send · Shift+Enter/Ctrl+J newline" : "Enter sends · Shift+Enter or Ctrl+J adds a line · Ctrl+V pastes image/text · / opens commands"}</Text>
    {attachments.length > 0 && <Text dimColor>  {columns < 80 ? "Tab images · Delete remove · Esc text" : "Tab selects images · ←/→ switches · Delete removes · Esc returns to text"}</Text>}
  </Box>;
}

export function composerCursorPosition(input: string, beforeCursor: string, columns: number, rows: number, hasError: boolean, hasAttachmentGuide: boolean, rowsAfterInput = 0): { x: number; y: number } {
  const inputWidth = Math.max(1, columns - 10);
  const cursor = wrappedPosition(beforeCursor, inputWidth);
  const end = wrappedPosition(input, inputWidth);
  return {
    x: ROOT_PADDING_X + 4 + cursor.column,
    // 全屏 Ink 渲染会把物理光标留在输出末行，而编辑器后缀按虚拟下一行计算；
    // 这里补偿两者差异，避免软换行后光标逐行下沉。
    y: Math.max(0, rows - 3 - (hasError ? 1 : 0) - (hasAttachmentGuide ? 1 : 0) - rowsAfterInput - (end.row - cursor.row)),
  };
}

function composerMaxRows(terminalRows: number): number { return Math.max(3, Math.min(10, Math.floor(terminalRows * 0.3))); }

export function composerViewport(input: string, cursorIndex: number, width: number, maxRows: number): { text: string; cursorIndex: number; linesAbove: number; linesBelow: number; visibleRows: number } {
  const characters = splitGraphemes(input);
  const cursor = Math.max(0, Math.min(cursorIndex, characters.length));
  const rows: Array<{ start: number; end: number }> = [];
  let start = 0; let column = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === "\n" || character === "\r") { rows.push({ start, end: index + 1 }); start = index + 1; column = 0; continue; }
    const characterWidth = visualWidth(character);
    if (column + characterWidth > width) { rows.push({ start, end: index }); start = index; column = 0; }
    column += characterWidth;
  }
  rows.push({ start, end: characters.length });
  const cursorRow = Math.max(0, rows.findIndex((row, index) => cursor >= row.start && (cursor < row.end || index === rows.length - 1)));
  const visibleLimit = Math.max(1, maxRows);
  const firstRow = Math.max(0, Math.min(cursorRow, rows.length - visibleLimit));
  const lastRow = Math.min(rows.length - 1, firstRow + visibleLimit - 1);
  const sliceStart = rows[firstRow]!.start;
  const rawSliceEnd = rows[lastRow]!.end;
  const sliceEnd = lastRow < rows.length - 1 && (characters[rawSliceEnd - 1] === "\n" || characters[rawSliceEnd - 1] === "\r") ? rawSliceEnd - 1 : rawSliceEnd;
  return {
    text: characters.slice(sliceStart, sliceEnd).join(""),
    cursorIndex: cursor - sliceStart,
    linesAbove: firstRow,
    linesBelow: rows.length - lastRow - 1,
    visibleRows: lastRow - firstRow + 1,
  };
}

function wrappedPosition(value: string, width: number): { row: number; column: number } {
  let row = 0; let column = 0;
  for (const character of splitGraphemes(value)) {
    if (character === "\n" || character === "\r") { row += 1; column = 0; continue; }
    const characterWidth = visualWidth(character);
    if (column + characterWidth > width) { row += 1; column = 0; }
    column += characterWidth;
  }
  return { row, column };
}

function TopBar({ projectDir, session, events }: { projectDir: string; session: SessionRecord | undefined; events: HarnessEvent[] }) {
  const projectName = path.basename(projectDir);
  const status = session?.status;
  const bar = sessionStatusBar(events, session);
  return <Box flexDirection="column" flexShrink={0}>
    <Box justifyContent="space-between">
      <Text><Text color="cyan" bold>RunHarness</Text>{projectName.toLowerCase() !== "runharness" && <Text dimColor>  {projectName}</Text>}</Text>
      <Text color={statusColor(status)}>{session ? `● ${status}` : "new session"}</Text>
    </Box>
    {session && <Text dimColor>{bar}</Text>}
  </Box>;
}

function Welcome({ columns, rows }: { columns: number; rows: number }) {
  if (columns < 60 || rows < 24) return <Box flexGrow={1} justifyContent="center" flexDirection="column" paddingX={1}>
    <Text color="cyan" bold>RunHarness</Text>
    <Text dimColor>Agent work you can observe, resume, and learn from.</Text>
    <Box marginTop={1} flexDirection="column">
      <Text><Text bold>New</Text><Text dimColor> · describe a change below</Text></Text>
      <Text><Text bold>Resume</Text><Text dimColor> · /session</Text></Text>
      <Text><Text bold>Dashboard</Text><Text dimColor> · /dashboard</Text></Text>
    </Box>
  </Box>;
  return <Box flexGrow={1} justifyContent="center" alignItems="center">
    <Box width={Math.max(36, Math.min(64, columns - 6))} borderStyle="round" borderColor="cyan" paddingX={4} paddingY={1} flexDirection="column">
      <Text bold>RunHarness</Text>
      <Text>Agent work you can observe, resume, and learn from.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text><Text bold>New session</Text><Text dimColor>      describe a change below</Text></Text>
        <Text><Text bold>Resume session</Text><Text dimColor>   /session · choose from a list</Text></Text>
        <Text><Text bold>Dashboard</Text><Text dimColor>        /dashboard</Text></Text>
        <Text><Text bold>Quit</Text><Text dimColor>             Ctrl+C</Text></Text>
      </Box>
    </Box>
  </Box>;
}

function SessionPicker({ sessions, index, query, currentSessionId, columns }: { sessions: SessionRecord[]; index: number; query: string; currentSessionId?: string; columns: number }) {
  const filtered = filterSessions(sessions, query);
  const visible = filtered.slice(Math.max(0, index - 4), Math.max(0, index - 4) + 9);
  return <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
    <Text bold>Choose Session</Text>
    <Text><Text color="cyan">Search: </Text>{query || <Text dimColor>type goal or status</Text>}</Text>
    <Text dimColor>type to filter · ↑/↓ select · Enter open · Esc/q/Ctrl+C keep current</Text>
    {!filtered.length && <Text dimColor>{sessions.length ? "No matching Sessions" : "No Sessions"}</Text>}
    {visible.map((item) => <Text key={item.id}>{filtered[index]?.id === item.id ? <Text color="cyan">› </Text> : <Text>  </Text>}<Text color={statusColor(item.status)}>● </Text>{truncateEnd(item.goal.replace(/\s+/g, " "), Math.max(20, columns - 54))}<Text dimColor> · {item.runCount} run · {item.status} · {item.workspacePlacement ?? "in_place"}{item.id === currentSessionId ? " · current" : ""}</Text></Text>)}
  </Box>;
}

function PermissionOverview({ runtime }: { runtime: RuntimeSettings | undefined }) {
  return <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
    <Text bold>Permission policy</Text>
    <Text dimColor>RunHarness policy is separate from provider sandbox and operating-system limits.</Text>
    <Box marginTop={1} flexDirection="column">
      <Text><Text bold>Workspace  </Text>{runtime ? `${runtime.executionPolicy.workspace.placement} · ${runtime.executionPolicy.workspace.access}` : "loading"}</Text>
      <Text><Text bold>Network    </Text>{runtime?.executionPolicy.network ?? "loading"}</Text>
      <Text><Text bold>Approval   </Text>{runtime?.executionPolicy.approvalMode ?? "loading"}</Text>
      <Text><Text bold>Rules      </Text>{runtime?.executionPolicy.customRules.length ?? 0}</Text>
      <Text><Text bold>Classifier </Text>{runtime?.safetyClassifier.enabled ? `${runtime.safetyClassifier.agentId ?? "unassigned"} · ${runtime.safetyClassifier.fallback}` : "off"}</Text>
    </Box>
    <Box marginTop={1} flexDirection="column"><Text>1. Built-in deterministic policy</Text><Text>2. Optional Safety Agent can only tighten</Text><Text>3. Provider-native sandbox still applies</Text></Box>
    <Text dimColor>Enter/Esc close · edit project defaults in Dashboard</Text>
  </Box>;
}

const HELP_SECTIONS: CommandSection[] = ["Sessions", "Run", "Review", "Results", "App"];

export function HelpOverview({ columns }: { columns: number }) {
  const split = columns >= 72;
  const sections = HELP_SECTIONS.map((name) => ({ name, commands: SLASH_COMMANDS.filter((command) => command.section === name) }));
  const renderSections = (items: typeof sections) => <Box flexDirection="column">
    {items.map((section, sectionIndex) => <Box key={section.name} flexDirection="column" marginTop={sectionIndex ? 1 : 0}>
      <Text bold>{section.name}</Text>
      {section.commands.map((command) => <HelpCommand key={command.command} command={command} columns={split ? Math.floor(columns / 2) - 6 : columns - 6} />)}
    </Box>)}
  </Box>;

  return <Box flexDirection="column" flexGrow={1} flexShrink={0} borderStyle="round" borderColor="cyan" paddingX={1}>
    <Text color="cyan" bold>RunHarness help</Text>
    {split && <Text dimColor>Plain text starts work. Slash commands control Sessions and the Runtime.</Text>}
    <Box marginTop={split ? 1 : 0} flexDirection={split ? "row" : "column"} columnGap={split ? 4 : 0}>
      {split ? <>
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>{renderSections(sections.slice(0, 2))}</Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0}>{renderSections(sections.slice(2))}</Box>
      </> : <Box flexDirection="column">{SLASH_COMMANDS.map((command) => <HelpCommand key={command.command} command={command} columns={columns - 6} />)}</Box>}
    </Box>
    <Box marginTop={1} flexDirection="column">
      {split ? <>
        <Text><Text bold>Keys  </Text><Text dimColor>↑/↓ edit/history · Tab complete · Shift+Enter/Ctrl+J newline</Text></Text>
        <Text dimColor>      Alt+↑ edit queued · Ctrl+- undo · Ctrl+O tools · Ctrl+V image/text · Ctrl+C stop/quit</Text>
      </> : <Text dimColor>Enter/Esc/q back · Ctrl+C quit · type a command for syntax</Text>}
    </Box>
  </Box>;
}

function HelpCommand({ command, columns }: { command: SlashCommand; columns: number }) {
  const commandWidth = Math.min(19, Math.max(17, Math.floor(columns * 0.42)));
  const descriptionWidth = Math.max(12, columns - commandWidth - 2);
  return <Text wrap="truncate"><Text color="cyan">  {command.command.padEnd(commandWidth)}</Text><Text dimColor>{truncateEnd(slashCommandDetail(command), descriptionWidth)}</Text></Text>;
}

function RecoveryCard({ session, result }: { session: SessionRecord; result: DevelopmentRunResult | undefined }) {
  const next = session.status === "running" ? "Attached to an existing active Run; no new work was started."
    : session.status === "waiting_for_plan_approval" ? "Review, revise, approve, or reject the proposed Plan."
      : session.status === "waiting_for_permission" ? "Review the pending action and choose an approval scope."
    : session.status === "completed" ? "Ordinary input starts a new Session; use /continue MESSAGE to refine this result."
      : session.status === "failed" || session.status === "stopped" ? "Inspect history, enter a correction to continue, or use /new." : "Enter a goal to start.";
  return <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="gray" flexShrink={0}>
    <Text><Text bold>Restored </Text>{shortId(session.id)} · {session.runCount} run{session.runCount === 1 ? "" : "s"} · <Text color={statusColor(session.status)}>{session.status}</Text></Text>
    <Text dimColor>{truncateEnd(session.goal.replace(/\s+/g, " "), 120)}</Text>
    <Text>{next}{result?.placement ? <Text dimColor> · {result.placement}</Text> : null}</Text>
  </Box>;
}

function WaitingSurface({ session, result, columns }: { session: SessionRecord | undefined; result: DevelopmentRunResult | undefined; columns: number }) {
  if (session?.status === "waiting_for_plan_approval" && result?.plan) return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} flexShrink={0}>
    <Text color="yellow" bold>Plan v{result.plan.version} · waiting for approval</Text>
    <Text>{truncateEnd(result.plan.text.replace(/\s+/g, " "), Math.max(40, columns * 2))}</Text>
    <Text dimColor>/plan approve · /plan revise PLAN · /plan reject REASON</Text>
  </Box>;
  if (session?.status === "waiting_for_permission" && result?.pendingApproval) return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} flexShrink={0}>
    <Text color="yellow" bold>Permission required</Text>
    <Text>{truncateEnd(result.pendingApproval.action.summary, Math.max(40, columns - 8))}</Text>
    <Text dimColor>{result.pendingApproval.baseDecision.reason}</Text>
    <Text dimColor>/permission approve once|session|project · /permission reject REASON</Text>
  </Box>;
  return null;
}

export function CommandPalette({ suggestions, index, columns }: { suggestions: SlashCommand[]; index: number; columns: number }) {
  if (!suggestions.length) return null;
  const compact = columns < 96;
  const visibleRows = compact ? 5 : 6;
  const windowStart = Math.max(0, Math.min(index - Math.floor(visibleRows / 2), suggestions.length - visibleRows));
  const visible = suggestions.slice(windowStart, windowStart + visibleRows);
  const commandWidth = compact ? 20 : 24;
  const descriptionWidth = Math.max(18, columns - commandWidth - 8);
  return <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} flexShrink={0}>
    {visible.map((item, itemIndex) => {
      const selected = windowStart + itemIndex === index;
      const command = truncateEnd(item.command, commandWidth - 2).padEnd(commandWidth - 2);
      const detail = truncateEnd(slashCommandDetail(item), descriptionWidth);
      return <Text key={item.command}>{selected
        ? <Text color="cyan" bold>› {command}</Text>
        : <Text>  {command}</Text>}<Text> </Text>{selected ? <Text>{detail}</Text> : <Text dimColor>{detail}</Text>}</Text>;
    })}
    <Text dimColor>↑/↓ select · {Math.min(index + 1, suggestions.length)}/{suggestions.length} · Tab complete · Enter run · /help all commands</Text>
  </Box>;
}

function ToolDetails({ events, expanded, columns }: { events: HarnessEvent[]; expanded: boolean; columns: number }) {
  const lines = toolDetailLines(events, columns);
  if (!expanded || !lines.length) return null;
  return <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} flexShrink={0}>
    <Text bold>Recent tool evidence</Text>
    {lines.map((line, index) => <Text key={`${index}-${line}`} dimColor>{line}</Text>)}
    <Text dimColor>Ctrl+O collapse</Text>
  </Box>;
}

function PendingInputSurface({ inputs, columns }: { inputs: PendingInput[]; columns: number }) {
  if (!inputs.length) return null;
  return <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1} flexShrink={0}>
    <Text color="cyan" bold>Pending follow-up · {inputs.length}</Text>
    {inputs.slice(0, 3).map((input, index) => <Text key={`${index}-${input.text}`} dimColor>{index + 1}. {truncateEnd(input.text.replace(/\s+/g, " "), Math.max(24, columns - 18))}{input.attachments.length ? ` · ${input.attachments.length} image${input.attachments.length === 1 ? "" : "s"}` : ""}</Text>)}
    <Text dimColor>Starts automatically after this Run · Alt+↑ or /dequeue edits the latest.</Text>
  </Box>;
}

/** 创建由持久结果驱动的历史块，使其随普通终端记录一起重排。 */
export function buildResultTranscriptItems(summary: TuiResultSummary, expanded: boolean, columns = 80): TranscriptItem[] {
  const outcomeTone = summary.outcome === "completed" ? "good" : summary.outcome === "failed" ? "bad" : "muted";
  const reviewTone = summary.review.decision === "accept" ? "good" : summary.review.decision === "request_changes" ? "bad" : "muted";
  const reviewLabel = summary.review.decision === "accept" ? "accepted"
    : summary.review.decision === "request_changes" ? "changes requested"
      : summary.review.decision === "unavailable" ? "unavailable" : "not run";
  const checksLabel = summary.checks.total ? `${summary.checks.passed}/${summary.checks.total} passed` : "not configured";
  const implementationLine = summary.implementation.replace(/^#+\s*/gm, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "No implementation summary was recorded.";
  const base: TranscriptItem[] = [
    { id: "stored-result-heading", kind: "stage", text: `Result · ${summary.outcome} · ${summary.iterations} iteration${summary.iterations === 1 ? "" : "s"}`, tone: outcomeTone },
  ];
  if (!expanded) {
    const rowWidth = Math.max(24, columns - 12);
    return [
    ...base,
      { id: "stored-result-implementation", kind: "activity", text: truncateEnd(`Implementation · ${implementationLine}`, rowWidth) },
      { id: "stored-result-quality", kind: "result", text: truncateEnd(`Checks · ${checksLabel} · Review ${reviewLabel}${summary.review.reviewer ? ` by ${summary.review.reviewer}` : ""}`, rowWidth), tone: summary.outcome === "completed" && summary.review.decision === "accept" ? "good" : reviewTone },
      { id: "stored-result-changes", kind: "activity", text: truncateEnd(`Changed · ${summary.changedFiles.length} file${summary.changedFiles.length === 1 ? "" : "s"} · ${summary.placement === "in_place" ? "in-place; already live" : summary.delivery}`, rowWidth) },
      { id: "stored-result-next", kind: "result", text: truncateEnd(`Next · ${summary.nextActions.map((item) => item.command).join(" · ")} · /result details`, rowWidth), tone: "accent" },
    ];
  }

  const items: TranscriptItem[] = [
    ...base,
    { id: "stored-result-implementation-heading", kind: "system", text: `Implementation\n${summary.implementation}`, tone: "accent" },
    { id: "stored-result-checks-heading", kind: "stage", text: `Checks · ${checksLabel}` },
    ...summary.checks.items.map<TranscriptItem>((item, index) => ({ id: `stored-result-check-${index}`, kind: "result", text: `${item.status} · ${item.summary}`, tone: item.status === "passed" ? "good" : item.status === "failed" || item.status === "denied" ? "bad" : "muted" })),
  ];
  if (!summary.checks.items.length) items.push({ id: "stored-result-check-none", kind: "result", text: "No configured acceptance evidence was recorded.", tone: "muted" });
  items.push(
    { id: "stored-result-review-heading", kind: "stage", text: `Review · ${reviewLabel}${summary.review.reviewer ? ` · ${summary.review.reviewer}` : ""}`, tone: reviewTone },
    { id: "stored-result-review", kind: "result", text: summary.review.text, tone: reviewTone },
    { id: "stored-result-files-heading", kind: "stage", text: `Changed files · ${summary.changedFiles.length}` },
    ...summary.changedFiles.map<TranscriptItem>((file, index) => ({ id: `stored-result-file-${index}`, kind: "activity", text: file })),
    { id: "stored-result-delivery", kind: "result", text: `Delivery · ${summary.delivery}`, tone: summary.placement === "in_place" || !summary.delivery.includes("pending") ? "good" : "accent" },
    { id: "stored-result-next-heading", kind: "stage", text: "Next" },
    ...summary.nextActions.map<TranscriptItem>((item, index) => ({ id: `stored-result-action-${index}`, kind: "result", text: `${item.command} · ${item.description}`, tone: "accent" })),
    { id: "stored-result-passive", kind: "result", text: "Stored Runtime data only · no model call", tone: "muted" },
  );
  return items;
}

export function Conversation({ transcript, events, notice, observerNotice = "", running }: {
  transcript: TranscriptItem[];
  events: HarnessEvent[];
  notice: string;
  observerNotice?: string;
  running: boolean;
}) {
  return <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" marginTop={1}>
    {transcript.map((item) => <TranscriptRow key={item.id} item={item} />)}
    {!transcript.length && <Text dimColor>{notice}</Text>}
    {observerNotice && <Text color="yellow">  • {observerNotice}</Text>}
    {running && <Box marginTop={1}><Text color="cyan">◆ </Text><Text>{currentActivity(events)}</Text></Box>}
  </Box>;
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  const color = item.tone === "bad" ? "red" : item.tone === "good" ? "green" : item.tone === "accent" ? "cyan" : undefined;
  if (item.kind === "user") return <Box marginTop={1} paddingX={1} width="100%" backgroundColor="#242424"><Text color="white" bold>› </Text><Text color="white">{item.text}</Text></Box>;
  if (item.kind === "stage") return <Box marginTop={1}><Text color="cyan">◆ </Text><Text bold>{item.text}</Text></Box>;
  if (item.kind === "activity") return <Box><Text dimColor>  └</Text><Box marginLeft={1}><Text dimColor>{item.text}</Text></Box></Box>;
  if (item.kind === "result") return color
    ? <Box><Text color={color}>  {item.tone === "bad" ? "×" : item.tone === "good" ? "✓" : "•"}</Text><Box marginLeft={1}><Text color={color}>{item.text}</Text></Box></Box>
    : <Box><Text dimColor>  • {item.text}</Text></Box>;
  return color ? <Box marginTop={1}><Text color={color}>• {item.text}</Text></Box> : <Box marginTop={1}><Text dimColor>• {item.text}</Text></Box>;
}

function Footer({ mode, maxIterations, running, baseUrl, columns, events, session, historyOffset }: {
  mode: Mode;
  maxIterations: number;
  running: boolean;
  baseUrl: string;
  columns: number;
  events: HarnessEvent[];
  session: SessionRecord | undefined;
  historyOffset: number;
}) {
  const live = running ? compactLiveStatus(events) : "";
  if (columns < 96) {
    return <Box justifyContent="space-between" flexShrink={0}>
      <Text dimColor>{running ? "Ctrl+C interrupt" : "/help · Shift+↑/↓ history · Ctrl+C quit"}</Text>
      <Text dimColor>{live || `${mode} · ${maxIterations} iter`}</Text>
    </Box>;
  }
  return <Box justifyContent="space-between" flexShrink={0}>
    <Text dimColor>{running ? "Ctrl+C interrupt · Ctrl+O tools · Shift+↑/↓ history" : "/help · Shift+↑/↓ history · Ctrl+O tools · Ctrl+V image · Ctrl+C quit"}</Text>
    <Text dimColor>{historyOffset ? `history -${historyOffset}` : live ? `${live} · ${mode}` : `${mode} · ${maxIterations} iter · ${session ? shortId(session.id) : new URL(baseUrl).port}`}</Text>
  </Box>;
}

export function deletePreviousGrapheme(input: string, cursorIndex: number): { input: string; cursorIndex: number } {
  const characters = splitGraphemes(input);
  const activeCursor = Math.min(Math.max(0, cursorIndex), characters.length);
  if (activeCursor > 0) characters.splice(activeCursor - 1, 1);
  return { input: characters.join(""), cursorIndex: Math.max(0, activeCursor - 1) };
}

export function deleteNextGrapheme(input: string, cursorIndex: number): { input: string; cursorIndex: number } {
  const characters = splitGraphemes(input);
  const cursor = Math.min(Math.max(0, cursorIndex), characters.length);
  if (cursor < characters.length) characters.splice(cursor, 1);
  return { input: characters.join(""), cursorIndex: cursor };
}

export function composerLineBoundary(input: string, cursorIndex: number, boundary: "start" | "end"): number {
  const characters = splitGraphemes(input);
  const cursor = Math.min(Math.max(0, cursorIndex), characters.length);
  if (boundary === "start") {
    for (let index = cursor - 1; index >= 0; index -= 1) if (characters[index] === "\n") return index + 1;
    return 0;
  }
  for (let index = cursor; index < characters.length; index += 1) if (characters[index] === "\n") return index;
  return characters.length;
}

export function composerWordBoundary(input: string, cursorIndex: number, direction: -1 | 1): number {
  const characters = splitGraphemes(input);
  const cursor = Math.min(Math.max(0, cursorIndex), characters.length);
  const codeUnitOffset = characters.slice(0, cursor).join("").length;
  const boundaries = new Set<number>([0, input.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(input)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const targetOffset = direction < 0
    ? [...ordered].reverse().find((offset) => offset < codeUnitOffset) ?? 0
    : ordered.find((offset) => offset > codeUnitOffset) ?? input.length;
  let offset = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (offset >= targetOffset) return index;
    offset += characters[index]!.length;
  }
  return characters.length;
}

export function deleteComposerRange(input: string, from: number, to: number): { input: string; cursorIndex: number } {
  const characters = splitGraphemes(input);
  const start = Math.max(0, Math.min(from, to, characters.length));
  const end = Math.max(start, Math.min(Math.max(from, to), characters.length));
  characters.splice(start, end - start);
  return { input: characters.join(""), cursorIndex: start };
}

export function moveComposerCursorVertical(input: string, cursorIndex: number, width: number, direction: -1 | 1, preferredColumn?: number): { cursorIndex: number; preferredColumn: number } {
  const characters = splitGraphemes(input);
  const cursor = Math.min(Math.max(0, cursorIndex), characters.length);
  const positions: Array<{ row: number; column: number }> = [{ row: 0, column: 0 }];
  let row = 0; let column = 0;
  for (const character of characters) {
    if (character === "\n" || character === "\r") { row += 1; column = 0; }
    else {
      const characterWidth = visualWidth(character);
      if (column + characterWidth > width) { row += 1; column = 0; }
      column += characterWidth;
    }
    positions.push({ row, column });
  }
  const current = positions[cursor]!;
  const targetRow = current.row + direction;
  const targetColumn = preferredColumn ?? current.column;
  if (targetRow < 0) return { cursorIndex: 0, preferredColumn: targetColumn };
  if (targetRow > row) return { cursorIndex: characters.length, preferredColumn: targetColumn };
  let best = cursor; let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index]!;
    if (position.row !== targetRow) continue;
    const nextDistance = Math.abs(position.column - targetColumn);
    if (nextDistance < distance || (nextDistance === distance && direction > 0 && index > best)) { best = index; distance = nextDistance; }
  }
  return { cursorIndex: best, preferredColumn: targetColumn };
}

function insertComposerText(input: string, cursorIndex: number, text: string): { input: string; cursorIndex: number } {
  const characters = splitGraphemes(input);
  const cursor = Math.max(0, Math.min(cursorIndex, characters.length));
  const inserted = splitGraphemes(text);
  return { input: [...characters.slice(0, cursor), ...inserted, ...characters.slice(cursor)].join(""), cursorIndex: cursor + inserted.length };
}

export function composerTextParts(input: string, cursorIndex: number): { before: string; cursor: string; after: string } {
  const characters = splitGraphemes(input); const cursor = Math.max(0, Math.min(cursorIndex, characters.length));
  return { before: characters.slice(0, cursor).join(""), cursor: characters[cursor] ?? " ", after: characters.slice(cursor + 1).join("") };
}

export function splitGraphemes(input: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input)].map((part) => part.segment);
}

export function suggestSlashCommands(input: string): SlashCommand[] {
  const value = input.trimStart();
  if (!value.startsWith("/") || value.includes(" ")) return [];
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(value));
}

export function filterSessions(sessions: SessionRecord[], query: string): SessionRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => `${session.id} ${session.goal} ${session.status}`.toLowerCase().includes(needle));
}

export function toolDetailLines(events: HarnessEvent[], columns = 80): string[] {
  return events.filter((event) => event.type === "tool_call" || event.type === "tool_result" || event.type === "agent_failed").slice(-6).map((event) => {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "agent_failed") {
      const reason = String(payload.summary ?? payload.message ?? "Agent failed without a recorded reason.");
      return `${agentStageLabel(event.actor, payload)} failed\n${reason}`;
    }
    const acceptance = configuredAcceptanceEvidence(payload);
    if (acceptance) {
      return truncateEnd(`acceptance · ${acceptanceName(acceptance)} · ${String(acceptance.status)} · ${String(acceptance.runtimeId ?? acceptance.placement)}${acceptance.failureCategory ? ` · ${String(acceptance.failureCategory)}` : ""}`, Math.max(24, columns - 8));
    }
    const tool = String(payload.tool ?? payload.name ?? "tool");
    const summary = compactToolSummary(payload.command ?? payload.summary, columns);
    const execution = payload.execution && typeof payload.execution === "object" && !Array.isArray(payload.execution) ? payload.execution as Record<string, unknown> : undefined;
    const boundary = execution ? [execution.owner, execution.placement].filter(Boolean).join("/") : "";
    const failure = payload.failure && typeof payload.failure === "object" ? payload.failure as Record<string, unknown> : undefined;
    const error = String(payload.stderr ?? payload.error ?? failure?.stderr ?? failure?.message ?? "").replace(/\s+/g, " ").trim();
    const state = event.type === "tool_call" ? "running" : payload.success === false || error ? "failed" : "done";
    return truncateEnd(`${tool} · ${state}${boundary ? ` · ${boundary}` : ""}${summary ? ` · ${summary}` : ""}${error ? ` · ${error}` : ""}`, Math.max(24, columns - 8));
  });
}

function configuredAcceptanceEvidence(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload.evidence || typeof payload.evidence !== "object" || Array.isArray(payload.evidence)) return undefined;
  const evidence = payload.evidence as Record<string, unknown>;
  return evidence.source === "configured_acceptance" ? evidence : undefined;
}

function acceptanceName(evidence: Record<string, unknown>): string {
  const native = evidence.native && typeof evidence.native === "object" && !Array.isArray(evidence.native) ? evidence.native as Record<string, unknown> : {};
  const spec = native.acceptance && typeof native.acceptance === "object" && !Array.isArray(native.acceptance) ? native.acceptance as Record<string, unknown> : {};
  return String(spec.name ?? evidence.capability ?? "acceptance");
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  const kept: string[] = [];
  let used = 1;
  for (const character of splitGraphemes(value).reverse()) {
    const characterWidth = stringWidth(character);
    if (used + characterWidth > width) break;
    kept.unshift(character); used += characterWidth;
  }
  return `…${kept.join("")}`;
}
function truncateEnd(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  const kept: string[] = [];
  let used = 1;
  for (const character of splitGraphemes(value)) {
    const characterWidth = stringWidth(character);
    if (used + characterWidth > width) break;
    kept.push(character); used += characterWidth;
  }
  return `${kept.join("")}…`;
}
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function buildTranscriptItems(events: HarnessEvent[], columns = 80): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const activeAgents = new Map<string, { label: string; tools: number; failures: number; latest?: string }>();
  const userRuns = new Set<string>();
  const progressiveMessages = new Map<string, number>();
  let latestUserText = "";
  let currentIteration = 0;
  let maxIterations = 0;

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.iteration === "number") currentIteration = payload.iteration;
    if (typeof payload.maxIterations === "number") maxIterations = payload.maxIterations;

    if (event.type === "session_started") {
      const goal = compactMessage(String(payload.goal ?? ""), columns);
      if (goal) {
        items.push({ id: event.id, kind: "user", text: withAttachmentCount(goal, payload.attachments) });
        latestUserText = goal; userRuns.add(event.runId);
      }
      continue;
    }
    if (event.type === "run_started") {
      activeAgents.clear();
      progressiveMessages.clear();
      currentIteration = 0;
      maxIterations = 0;
      const message = compactMessage(String(payload.userInput ?? payload.message ?? payload.goal ?? ""), columns);
      if (message && (!userRuns.has(event.runId) || message !== latestUserText)) {
        items.push({ id: event.id, kind: "user", text: withAttachmentCount(message, payload.attachments) });
        latestUserText = message; userRuns.add(event.runId);
      }
      continue;
    }
    if (event.type === "iteration_started") {
      const iter = Number(payload.iteration ?? (currentIteration || 1));
      const max = Number(payload.maxIterations ?? (maxIterations || "?"));
      items.push({ id: event.id, kind: "stage", text: `Iteration ${iter}/${max}` });
      continue;
    }
    if (event.type === "agent_started") {
      const label = agentStageLabel(event.actor, payload, currentIteration);
      activeAgents.set(event.actor, { label, tools: 0, failures: 0 });
      // 角色开始时立即显示阶段和模型，完成前也能观察真实过程。
      items.push({ id: event.id, kind: "stage", text: label });
      continue;
    }
    if (event.type === "tool_call") {
      progressiveMessages.clear();
      const active = activeAgents.get(event.actor);
      if (active) active.tools += 1;
      if (payload.tool === "acceptance") continue;
      const tool = String(payload.tool ?? payload.name ?? "tool");
      const summary = compactToolSummary(payload.summary ?? payload.command, columns);
      const modelHint = agentIdentity(payload);
      if (active) active.latest = summary ? `${tool} · ${summary}` : tool;
      items.push({
        id: event.id,
        kind: "activity",
        text: [modelHint && !active ? modelHint : undefined, summary ? `${tool} · ${summary}` : tool].filter(Boolean).join(" · "),
      });
      continue;
    }
    if (event.type === "tool_result") {
      progressiveMessages.clear();
      const acceptance = configuredAcceptanceEvidence(payload);
      if (acceptance) {
        items.push({
          id: event.id, kind: "result", tone: acceptance.status === "passed" ? "good" : acceptance.blocksCompletion ? "bad" : "muted",
          text: `Acceptance ${acceptanceName(acceptance)} · ${String(acceptance.status)} · ${String(acceptance.runtimeId ?? acceptance.placement)} · ${formatDuration(Number(acceptance.durationMs ?? 0))}`,
        });
        continue;
      }
      if (payload.success === false) {
        const tool = String(payload.tool ?? payload.name ?? "tool");
        const active = activeAgents.get(event.actor);
        if (active) { active.failures += 1; active.latest = `${tool} failed`; continue; }
        items.push({ id: event.id, kind: "result", tone: "bad", text: `${tool} failed` });
      }
      continue;
    }
    if (event.type === "agent_completed") {
      progressiveMessages.clear();
      const active = activeAgents.get(event.actor);
      const details = [
        active?.tools ? `${active.tools} action${active.tools === 1 ? "" : "s"}` : "",
        active?.failures ? `${active.failures} failed` : "",
        active?.latest ? `latest: ${active.latest}` : "",
        formatDuration(Number(payload.durationMs ?? 0)),
        agentIdentity(payload),
      ].filter(Boolean).join(" · ");
      if (details) items.push({ id: `${event.id}-details`, kind: "activity", text: details });
      activeAgents.delete(event.actor);
      continue;
    }
    if (event.type === "agent_failed") {
      progressiveMessages.clear();
      const reason = String(payload.summary ?? payload.message ?? "Agent failed without a recorded reason.");
      items.push({
        id: event.id,
        kind: "result",
        tone: "bad",
        text: `${agentStageLabel(event.actor, payload, currentIteration)} failed\n${reason}`,
      });
      activeAgents.delete(event.actor);
      continue;
    }
    if (event.type === "handoff") {
      progressiveMessages.clear();
      const summary = shortText(humanizeDisplayText(payload.summary ?? payload.plan), columns * 3);
      if (summary) items.push({ id: event.id, kind: "activity", text: summary });
      continue;
    }
    if (event.type === "verdict") {
      progressiveMessages.clear();
      const reviewer = String(payload.reviewer ?? (agentIdentity(payload) || "evaluator"));
      const decision = String(payload.decision ?? "unavailable");
      items.push({
        id: event.id,
        kind: "result",
        tone: decision === "accept" ? "good" : decision === "request_changes" ? "bad" : "accent",
        text: `Review · ${reviewer} · ${decision.replaceAll("_", " ")} · ${shortText(humanizeDisplayText(payload.text), columns * 2)}`,
      });
      continue;
    }
    if (event.type === "message") {
      if (payload.action === "stop_requested") {
        items.push({ id: event.id, kind: "system", tone: "muted", text: "Stop requested" });
        continue;
      }
      // 展示所有角色及 API 回合的中间思考和正文。
      const body = shortText(humanizeDisplayText(payload.summary ?? payload.text ?? payload.message), columns * 3);
      if (!body) continue;
      const phase = payload.phase === "thinking" ? "thinking" : payload.phase === "status" ? "status" : "draft";
      const active = activeAgents.get(event.actor);
      if (active) active.latest = `${phase} · ${body}`;
      const key = `${event.actor}:${phase}`;
      const previous = progressiveMessages.get(key);
      const item = { id: event.id, kind: "activity" as const, text: `${phase} · ${body}` };
      if (previous === undefined) {
        progressiveMessages.set(key, items.length);
        items.push(item);
      } else items[previous] = item;
      continue;
    }
    if (event.type === "plan_proposed") { items.push({ id: event.id, kind: "result", tone: "accent", text: `Plan v${String(payload.version ?? 1)} proposed · ${shortText(payload.text, columns * 2)}` }); continue; }
    if (event.type === "plan_approved") { items.push({ id: event.id, kind: "result", tone: "good", text: `Plan v${String(payload.version ?? 1)} approved` }); continue; }
    if (event.type === "plan_rejected") { items.push({ id: event.id, kind: "result", tone: "bad", text: `Plan rejected · ${shortText(payload.reason, columns)}` }); continue; }
    if (event.type === "approval_requested") { items.push({ id: event.id, kind: "result", tone: "accent", text: `Permission requested · ${shortText((payload.action as Record<string, unknown> | undefined)?.summary, columns * 2)}` }); continue; }
    if (event.type === "approval_decided") { items.push({ id: event.id, kind: "result", tone: payload.decision === "approve" ? "good" : "bad", text: `Permission ${String(payload.decision)} · ${String(payload.scope ?? "once")}` }); continue; }
    if (event.type === "run_completed") items.push({ id: event.id, kind: "result", tone: "good", text: "Run completed" });
    else if (event.type === "run_failed") items.push({ id: event.id, kind: "result", tone: "bad", text: `Run failed · ${shortText(humanizeDisplayText(payload.message), columns * 2)}` });
    else if (event.type === "run_stopped") items.push({ id: event.id, kind: "result", tone: "muted", text: "Run stopped" });
  }
  return items;
}

function agentIdentity(payload: Record<string, unknown>): string {
  return [payload.agentId ?? payload.backend, payload.model].filter(Boolean).join(" · ");
}

function agentStageLabel(actor: string, payload: Record<string, unknown>, fallbackIteration = 0): string {
  const role = roleLabel(actor);
  const identity = agentIdentity(payload);
  const iteration = typeof payload.iteration === "number" ? payload.iteration : fallbackIteration;
  const iter = actor !== "planner" && iteration > 0 ? `iteration ${iteration}` : undefined;
  return [role, iter, identity].filter(Boolean).join(" · ");
}

function compactToolSummary(value: unknown, columns: number): string {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  // 优先展示有意义的命令尾部，隐藏冗长的 shell 启动包装。
  const unwrapped = raw.replace(/^\/bin\/(?:ba)?zsh\s+-lc\s+["']?/, "").replace(/["']$/, "");
  return truncateEnd(unwrapped, Math.max(36, Math.min(96, columns - 18)));
}

export function humanizeDisplayText(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!looksLikeStreamDump(raw)) return raw;
  const parts: string[] = [];
  let stopReason = "";
  let claudeResult = "";
  let codexMessage = "";
  for (const line of raw.split("\n")) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if ((record.type === "text" || record.type === "thought") && typeof record.data === "string") parts.push(record.data);
      if (record.type === "end" && typeof record.stopReason === "string") stopReason = record.stopReason;
      if (record.type === "result" && typeof record.result === "string") claudeResult = record.result;
      if (record.type === "assistant" && record.message && typeof record.message === "object") {
        const content = (record.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: string }).text === "string") {
              parts.push((block as { text: string }).text);
            }
          }
        }
      }
      if ((record.type === "item.completed" || record.type === "item.updated") && record.item && typeof record.item === "object") {
        const item = record.item as { type?: string; text?: string };
        if (item.type === "agent_message" && typeof item.text === "string") codexMessage = item.text;
      }
    } catch { /* 当前事件无可读结果时继续向前查找。 */ }
  }
  if (parts.join("").trim()) return parts.join("").replace(/\s+/g, " ").trim();
  if (claudeResult.trim()) return claudeResult.trim();
  if (codexMessage.trim()) return codexMessage.replace(/\s+/g, " ").trim();
  if (stopReason) return stopReason === "Cancelled" ? "Agent run was cancelled before a final answer." : `Agent stopped (${stopReason}).`;
  return "Agent produced no readable final text.";
}

function looksLikeStreamDump(value: string): boolean {
  const sample = value.slice(0, 320).trim();
  if (!sample.startsWith("{") && !sample.startsWith("[")) return false;
  return (
    sample.includes('"type":"thought"')
    || sample.includes('"type":"text"')
    || sample.includes('"type":"end"')
    || sample.includes('"type":"assistant"')
    || sample.includes('"type":"result"')
    || sample.includes('"type":"item.started"')
    || sample.includes('"type":"item.completed"')
  );
}

function shortId(id: string): string {
  const parts = id.split("_");
  return parts.length >= 2 ? `${parts[0]}_${parts[1]?.slice(0, 6) ?? ""}` : id.slice(0, 14);
}

export function sessionStatusBar(events: HarnessEvent[], session: SessionRecord | undefined): string {
  if (!session) return "";
  const currentEvents = eventsForLatestRun(events, session.latestRunId);
  const iteration = latestIteration(currentEvents);
  const maxIterations = latestMaxIterations(currentEvents);
  const tools = currentEvents.filter((event) => event.type === "tool_call" && (event.payload as { tool?: unknown }).tool !== "acceptance").length;
  const stage = compactLiveStatus(currentEvents);
  const elapsed = formatElapsed(currentEvents);
  const bits = [
    shortId(session.id),
    session.workspacePlacement ?? "in_place",
    session.workspaceAccess ?? "read_write",
    session.deliveryStatus,
    `${session.runCount} run${session.runCount === 1 ? "" : "s"}`,
    iteration ? (maxIterations ? `iteration ${iteration}/${maxIterations}` : `iteration ${iteration}`) : undefined,
    tools ? `${tools} tools` : undefined,
    stage || undefined,
    elapsed || undefined,
  ].filter(Boolean);
  return bits.join(" · ");
}

function latestMaxIterations(events: HarnessEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload as Record<string, unknown> | undefined;
    if (typeof payload?.maxIterations === "number") return payload.maxIterations;
  }
  return undefined;
}

function latestIteration(events: HarnessEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload as Record<string, unknown> | undefined;
    if (typeof payload?.iteration === "number") return payload.iteration;
  }
  return undefined;
}

function formatElapsed(events: HarnessEvent[]): string {
  const start = events.find((event) => event.type === "run_started" || event.type === "session_started");
  if (!start) return "";
  const startedAt = Date.parse(start.timestamp);
  if (!Number.isFinite(startedAt)) return "";
  return formatDuration(Date.now() - startedAt);
}

function compactLiveStatus(events: HarnessEvent[]): string {
  const latest = [...events].reverse().find((event) => ["agent_started", "agent_completed", "agent_failed", "tool_call", "tool_result", "message", "iteration_started", "handoff", "verdict", "run_completed", "run_failed", "run_stopped"].includes(event.type));
  if (!latest) return "preparing";
  const payload = latest.payload as Record<string, unknown>;
  const identity = agentIdentity(payload);
  const iter = typeof payload.iteration === "number" ? `i${payload.iteration}` : undefined;
  if (latest.type === "agent_started") return [roleLabel(latest.actor), iter, identity || "agent"].filter(Boolean).join(" · ");
  if (latest.type === "message" && payload.action !== "stop_requested") {
    const phase = payload.phase === "thinking" ? "thinking" : payload.phase === "status" ? "status" : "draft";
    return [roleLabel(latest.actor), iter, identity, phase].filter(Boolean).join(" · ");
  }
  if (latest.type === "tool_call") {
    const tool = String(payload.tool ?? payload.name ?? "tool");
    return [roleLabel(latest.actor), iter, identity, tool].filter(Boolean).join(" · ");
  }
  if (latest.type === "tool_result" && configuredAcceptanceEvidence(payload)) return `acceptance · ${acceptanceName(configuredAcceptanceEvidence(payload)!)}`;
  if (latest.type === "handoff") return [roleLabel(latest.actor), identity, "done"].filter(Boolean).join(" · ");
  if (latest.type === "verdict") return ["Review", String(payload.reviewer ?? identity)].filter(Boolean).join(" · ");
  if (latest.type === "iteration_started") return `Iteration ${payload.iteration}${payload.maxIterations ? `/${payload.maxIterations}` : ""}`;
  if (latest.type === "agent_completed") return [roleLabel(latest.actor), identity, "done"].filter(Boolean).join(" · ");
  return latest.type.replaceAll("_", " ");
}


export function fitTranscriptItems(items: TranscriptItem[], rowBudget: number, columns: number): TranscriptItem[] {
  return fitTranscriptItemsAtOffset(items, rowBudget, columns, 0);
}

export function fitTranscriptItemsAtOffset(items: TranscriptItem[], rowBudget: number, columns: number, offset: number, preserveLatestUser = true): TranscriptItem[] {
  const end = Math.max(0, items.length - Math.max(0, offset));
  const source = items.slice(0, end);
  const selected: TranscriptItem[] = [];
  let usedRows = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index]!;
    const rows = transcriptItemRows(item, columns);
    if (selected.length && usedRows + rows > rowBudget) break;
    selected.unshift(item); usedRows += rows;
  }

  if (offset > 0 || !preserveLatestUser) return selected;
  const latestUser = [...source].reverse().find((item) => item.kind === "user");
  if (!latestUser || selected.some((item) => item.id === latestUser.id)) return selected;
  const userRows = transcriptItemRows(latestUser, columns);
  while (selected.length && usedRows + userRows > rowBudget) {
    const removed = selected.shift()!;
    usedRows -= transcriptItemRows(removed, columns);
  }
  return [latestUser, ...selected];
}

function transcriptItemRows(item: TranscriptItem, columns: number): number {
  const width = Math.max(12, columns - 8);
  const contentRows = item.text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(visualWidth(line) / width)), 0);
  return contentRows + (item.kind === "user" || item.kind === "stage" || item.kind === "system" ? 1 : 0);
}

function visualWidth(value: string): number {
  return stringWidth(value);
}

function compactMessage(value: string, columns: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/[ \t]+/g, " ").trim();
  return truncateEnd(normalized, Math.max(160, columns * 4));
}

function withAttachmentCount(text: string, attachments: unknown): string {
  return Array.isArray(attachments) && attachments.length ? `${text}  [${attachments.length} image${attachments.length === 1 ? "" : "s"}]` : text;
}

function shortText(value: unknown, width: number): string {
  return truncateEnd(String(value ?? "").replace(/\s+/g, " ").trim(), Math.max(24, width));
}

/** 项目模型唯一使用的三种角色名：planner、generator、evaluator。 */
function roleLabel(actor: string): string {
  return actor === "planner" || actor === "generator" || actor === "evaluator" ? "Agent" : actor === "safety" ? "Safety" : actor;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function currentActivity(events: HarnessEvent[]): string {
  const latest = [...events].reverse().find((event) => ["agent_started", "agent_completed", "agent_failed", "tool_call", "tool_result", "message", "iteration_started", "handoff", "verdict", "run_completed", "run_failed", "run_stopped"].includes(event.type));
  if (!latest) return "preparing workspace…";
  const payload = latest.payload as Record<string, unknown>;
  const identity = agentIdentity(payload);
  const iter = typeof payload.iteration === "number" ? `iteration ${payload.iteration}` : undefined;
  if (latest.type === "agent_started") return [roleLabel(latest.actor), iter, identity || "agent", "working…"].filter(Boolean).join(" · ");
  if (latest.type === "message" && payload.action !== "stop_requested") {
    const phase = payload.phase === "thinking" ? "thinking" : payload.phase === "status" ? "status" : "draft";
    return [roleLabel(latest.actor), iter, identity, phase, compactToolSummary(payload.summary ?? payload.text, 72)].filter(Boolean).join(" · ");
  }
  if (latest.type === "tool_call") return [roleLabel(latest.actor), iter, identity, String(payload.tool ?? payload.name ?? "tool"), compactToolSummary(payload.summary ?? payload.command, 72)].filter(Boolean).join(" · ");
  if (latest.type === "tool_result" && configuredAcceptanceEvidence(payload)) return `acceptance · ${acceptanceName(configuredAcceptanceEvidence(payload)!)}`;
  if (latest.type === "tool_result") return [roleLabel(latest.actor), iter, identity, "next step…"].filter(Boolean).join(" · ");
  if (latest.type === "handoff") return [roleLabel(latest.actor), identity, "handed off"].filter(Boolean).join(" · ");
  if (latest.type === "verdict") return ["Review", String(payload.reviewer ?? (identity || "done"))].filter(Boolean).join(" · ");
  if (latest.type === "iteration_started") return `Starting iteration ${payload.iteration}${payload.maxIterations ? ` of ${payload.maxIterations}` : ""}`;
  if (latest.type === "agent_completed") return [roleLabel(latest.actor), identity, "finished"].filter(Boolean).join(" · ");
  return latest.type.replaceAll("_", " ");
}

function statusColor(status?: string): "gray" | "yellow" | "green" | "red" { return status === "running" || status?.startsWith("waiting_") ? "yellow" : status === "completed" ? "green" : status === "failed" ? "red" : "gray"; }
export async function openBrowser(url: string): Promise<void> {
  if (process.env.RUNHARNESS_NO_OPEN === "1") return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`Could not open ${url}: ${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function streamSessionEvents(url: string, signal: AbortSignal, onEvent: (event: HarnessEvent) => void, onOpen?: () => void): Promise<void> {
  const response = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error(`Could not stream Session events (${response.status})`);
  onOpen?.();
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Session event stream became idle")), 7_000); });
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await Promise.race([reader.read(), timeout]); }
    catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { if (timer) clearTimeout(timer); }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const eventName = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (eventName === "harness-event" && data) onEvent(JSON.parse(data) as HarnessEvent);
      if (eventName === "end") { await reader.cancel(); return; }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchAllSessionEvents(baseUrl: string, sessionId: string, request: typeof fetch = fetch): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for (let offset = 0; ; offset += 500) {
    const response = await request(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events?offset=${offset}&limit=500`);
    if (!response.ok) throw new Error(`Could not load Session events (${response.status})`);
    const page = await response.json() as HarnessEvent[];
    events.push(...page);
    if (page.length < 500) return events;
  }
}
