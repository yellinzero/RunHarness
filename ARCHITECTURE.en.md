# RunHarness architecture

[中文](ARCHITECTURE.md)

This document gives a concise map of how the current code works together.

## How one task runs

```text
User input
   │
   ▼
TUI ──HTTP/SSE── Project Runtime
                     │
                     ├─ create Session / Run
                     ├─ Planner produces a plan
                     ├─ Generator works in the selected workspace
                     ├─ configured checks collect evidence
                     ├─ Evaluator reviews evidence and changes
                     └─ complete / iterate / fail / stop
```

`POST /api/sessions` creates the records and returns immediately. The Runtime executes the task in the background and writes Agent messages, tool calls, checks, approvals, and terminal outcomes into one event stream. The TUI and Dashboard do not maintain separate task state; both read the same API, SSE stream, and Session store.

## Module boundaries

```text
packages/cli
  commands/   argument parsing, data maintenance, non-interactive output
  runtime/    Dashboard asset discovery and local port lifecycle
  terminal/   keyboard protocol, screen ownership, images, clipboard
  ui/         Ink TUI and result summaries

apps/server
  Project Runtime, HTTP API, SSE, attachments, Runtime discovery

apps/dashboard
  React control plane for observing and configuring the Project Runtime

packages/development
  loop/          Planner → Generator → Evaluator cycle
  runtime/       executable-check Runtime interfaces and failure categories
  verification/  project checks converted into Evidence
  workspace/     in-place / isolated workspaces, baselines, delivery

packages/core
  session/   Session, Run, and JSONL event storage
  prompts/   versioned Prompt slots
  memory/    recovery context and Run summaries for long tasks

packages/providers
  backends/  CLI, API, and concrete transports
  routing/   Agent configuration, role assignment, fallback
  runtime/   backend contracts, Provider sessions, child processes
  tools/     MCP, lifecycle control tools, permission decisions

packages/shared
  Session, Agent, Evidence, Workspace, and API contracts shared across modules
```

## Sessions, Runs, and iterations

- A Session is a resumable body of work and conversation.
- Each new user submission creates a Run.
- One Run may contain several implementation and review iterations.
- Continue creates a new Run in the same Session. Steer stops the current Run and sends the new requirement together with existing evidence back to planning.
- Every Run must reach a terminal state. Plan and permission gates are explicit states that resume the same Run.

## Agents and lifecycle control

Planner, Generator, and Evaluator all use the `AgentBackend` contract. Natural-language output is preserved as written and does not need to be JSON. Conclusions that change the lifecycle use read-only control tools, such as accepting a review, requesting changes, or reporting that review is unavailable.

API backends include a bounded model-to-MCP tool loop. CLI backends preserve the native transport and capabilities of their Agent. Provider-native tools cannot always report every action to RunHarness, so events distinguish work executed by RunHarness, by the Provider, or by an external environment.

## Workspaces and delivery

- `in_place`: the Agent edits the current project workspace directly.
- `isolated`: Git projects use a worktree; non-Git projects use a managed copy. The user inspects the result, then chooses apply or discard.

The Runtime records a baseline and change set for each Run. Apply checks whether the source workspace has changed in conflicting ways. Cleanup only removes directories that RunHarness explicitly owns.

## Evidence and permissions

Project commands, MCP tools, and future container, VM, device, or remote checks implement `ExecutionRuntime`. Each returns consistent Evidence describing ownership, execution placement, status, failure category, and artifacts.

Permissions have three layers: deterministic project policy, optional Safety evaluation, and human confirmation. This hard boundary applies only to actions dispatched by RunHarness. Provider-internal actions remain subject to the Provider's own sandbox and protocol capabilities.

## Local data

Each project receives a data directory keyed by its project-root hash. It contains configuration, Sessions, Runs, events, attachments, Prompts, Memory, and isolated workspaces. The Runtime discovery directory stores only minimal online metadata such as local addresses; it does not copy project contents.
