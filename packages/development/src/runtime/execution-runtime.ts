import {
  createId,
  type AcceptanceSpec,
  type ArtifactReference,
  type EvidenceFailureCategory,
  type EvidenceRecord,
  type McpServerConfig,
  type RuntimeDescriptor,
} from "@runharness/shared";
import { evaluatePermission, McpToolSession, PermissionDeniedError, PermissionRequiredError, runProcess, type AgentCall } from "@runharness/providers";

export interface RuntimeExecutionContext {
  workspace: string;
  signal?: AbortSignal;
  permission?: AgentCall["permission"];
}

export interface RuntimeExecutionResult {
  status: "passed" | "failed" | "unavailable" | "denied" | "cancelled";
  summary: string;
  failureCategory?: EvidenceFailureCategory;
  artifacts?: ArtifactReference[];
  native?: unknown;
}

/** 管理一类 RunHarness 动作的执行位置和完整生命周期。 */
export interface ExecutionRuntime {
  readonly descriptor: RuntimeDescriptor;
  start(context: RuntimeExecutionContext): Promise<void>;
  execute(spec: AcceptanceSpec, context: RuntimeExecutionContext): Promise<RuntimeExecutionResult>;
  stop(): Promise<void>;
}

/** 创建项目可用的执行 Runtime 集合，使开发循环不依赖具体运行环境。 */
export type ExecutionRuntimeFactory = (mcpServers?: Record<string, McpServerConfig>) => ExecutionRuntime[];

export class ExecutionRuntimeRegistry {
  private readonly runtimes = new Map<string, ExecutionRuntime>();
  private readonly startupFailures = new Map<string, string>();
  private readonly started = new Set<string>();

  constructor(runtimes: ExecutionRuntime[]) {
    for (const runtime of runtimes) {
      if (this.runtimes.has(runtime.descriptor.id)) throw new Error(`Duplicate execution Runtime '${runtime.descriptor.id}'`);
      this.runtimes.set(runtime.descriptor.id, runtime);
    }
  }

  descriptors(): RuntimeDescriptor[] { return [...this.runtimes.values()].map((runtime) => runtime.descriptor); }

  async execute(spec: AcceptanceSpec, context: RuntimeExecutionContext): Promise<EvidenceRecord> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const runtime = this.runtimes.get(spec.runtime);
    if (runtime && !this.started.has(spec.runtime) && !this.startupFailures.has(spec.runtime)) {
      try { await runtime.start(context); this.started.add(spec.runtime); }
      catch (error) {
        this.startupFailures.set(spec.runtime, errorMessage(error));
        await runtime.stop().catch(() => undefined);
      }
    }
    const startupFailure = this.startupFailures.get(spec.runtime);
    let result: RuntimeExecutionResult;
    if (!runtime) {
      result = { status: "unavailable", summary: `Execution Runtime '${spec.runtime}' is not configured`, failureCategory: "missing_dependency" };
    } else if (startupFailure) {
      result = { status: "unavailable", summary: startupFailure, failureCategory: "transport" };
    } else {
      try { result = await runtime.execute(spec, context); }
      catch (error) {
        if (error instanceof PermissionRequiredError) throw error;
        result = classifyRuntimeError(error, context.signal);
      }
    }
    const descriptor = runtime?.descriptor;
    return {
      id: createId("evidence"),
      source: "configured_acceptance",
      owner: descriptor?.owner ?? "external",
      ...(descriptor ? { runtimeId: descriptor.id } : {}),
      placement: descriptor?.placement ?? "unknown",
      capability: spec.kind,
      requirement: spec.required ? "required" : "optional",
      status: result.status,
      ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
      blocksCompletion: spec.required && result.status !== "passed",
      summary: result.summary,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      artifacts: result.artifacts ?? [],
      native: { acceptance: spec, result: result.native },
    };
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.started].map((id) => this.runtimes.get(id)!.stop()));
    this.started.clear();
  }
}

export class LocalCommandRuntime implements ExecutionRuntime {
  readonly descriptor: RuntimeDescriptor = {
    id: "local-command",
    label: "Local project command",
    owner: "runharness",
    placement: "host",
    capabilities: ["command"],
    controlled: true,
    detail: "Runs configured project acceptance commands as children of the Project Runtime.",
    limitations: ["A host child process is not OS containment; use a container or VM Runtime for untrusted code."],
  };

  async start(): Promise<void> {}

  async execute(spec: AcceptanceSpec, context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (spec.kind !== "command") return unsupported(this.descriptor.id, spec.kind);
    if (context.permission) {
      const action = { kind: "command" as const, summary: spec.command, command: spec.command };
      const decision = await context.permission.decide(action, evaluatePermission(context.permission.policy, action));
      if (decision.decision === "ask") throw new PermissionRequiredError(action, decision);
      if (decision.decision === "deny") throw new PermissionDeniedError(action, decision);
    }
    const shell = shellInvocation(spec.command);
    const result = await runProcess(shell.executable, shell.args, {
      cwd: context.workspace,
      timeoutMs: spec.timeoutMs ?? 300_000,
      env: { ...process.env, CI: "1" },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const output = { command: spec.command, exitCode: result.code, stdout: tail(result.stdout), stderr: tail(result.stderr) };
    return result.code === 0
      ? { status: "passed", summary: `${spec.name} passed`, native: output }
      : { status: "failed", summary: `${spec.name} exited with ${result.code ?? "no exit code"}`, failureCategory: classifyCommandFailure(output), native: output };
  }

  async stop(): Promise<void> {}
}

export class ProjectMcpRuntime implements ExecutionRuntime {
  readonly descriptor: RuntimeDescriptor;
  private session: McpToolSession | undefined;

  constructor(private readonly servers: Record<string, McpServerConfig>) {
    const placements = new Set(Object.values(servers).filter((server) => server.enabled !== false).map((server) => server.command ? "host" as const : "remote" as const));
    this.descriptor = {
      id: "project-mcp",
      label: "Project MCP",
      owner: "runharness",
      placement: placements.size === 1 ? [...placements][0]! : "unknown",
      capabilities: ["tool"],
      controlled: true,
      detail: "RunHarness owns configured stdio/HTTP MCP connections, permissions, cancellation, and results.",
      limitations: placements.size > 1 ? ["Mixed local and remote MCP servers have different process boundaries; inspect each server configuration."] : [],
    };
  }

  async start(context: RuntimeExecutionContext): Promise<void> {
    this.session = await McpToolSession.open(this.servers, context.workspace);
  }

  async execute(spec: AcceptanceSpec, context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (spec.kind !== "tool") return unsupported(this.descriptor.id, spec.kind);
    if (!this.session) return { status: "unavailable", summary: "Project MCP Runtime is not connected", failureCategory: "transport" };
    const result = await this.session.call(spec.tool, spec.input, context.permission, { ...(context.signal ? { signal: context.signal } : {}), ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) });
    return result.isError
      ? { status: "failed", summary: result.output, failureCategory: "assertion", native: result }
      : { status: "passed", summary: result.output || `${spec.name} passed`, native: result };
  }

  async stop(): Promise<void> { await this.session?.close(); this.session = undefined; }
}

export const createExecutionRuntimes: ExecutionRuntimeFactory = (mcpServers) => {
  return [new LocalCommandRuntime(), ...(mcpServers && Object.values(mcpServers).some((server) => server.enabled !== false) ? [new ProjectMcpRuntime(mcpServers)] : [])];
};

function classifyRuntimeError(error: unknown, signal?: AbortSignal): RuntimeExecutionResult {
  const summary = errorMessage(error);
  if (signal?.aborted || /abort/i.test(summary)) return { status: "cancelled", summary, failureCategory: "cancelled" };
  if (error instanceof PermissionDeniedError || error instanceof PermissionRequiredError) return { status: "denied", summary, failureCategory: "permission" };
  if (/timed? ?out|requesttimeout/i.test(summary)) return { status: "unavailable", summary, failureCategory: "timeout" };
  return { status: "unavailable", summary, failureCategory: "transport" };
}

function unsupported(runtime: string, kind: AcceptanceSpec["kind"]): RuntimeExecutionResult {
  return { status: "unavailable", summary: `Execution Runtime '${runtime}' does not support '${kind}'`, failureCategory: "missing_dependency" };
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  return process.platform === "win32"
    ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { executable: process.env.SHELL ?? "/bin/sh", args: ["-lc", command] };
}

function classifyCommandFailure(result: { stdout: string; stderr: string }): EvidenceFailureCategory {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/operation not permitted|sandbox|mach port|bootstrap_check_in/.test(output)) return "sandbox";
  if (/eacces|eperm|permission denied|401|403|unauthorized|forbidden/.test(output)) return "permission";
  if (/command not found|enoent|no such file|missing dependency/.test(output)) return "missing_dependency";
  if (/timed? ?out|etimedout/.test(output)) return "timeout";
  if (/spawn|failed to launch|cannot open display/.test(output)) return "process_launch";
  return "assertion";
}

function tail(value: string, max = 20_000): string { return value.length <= max ? value : `... truncated ...\n${value.slice(-max)}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
