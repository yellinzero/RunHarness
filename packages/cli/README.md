# RunHarness

RunHarness is an experimental, observable Agent Harness built for learning. It runs real development work through a terminal TUI while a local Dashboard observes the same Session, Run, Agent, tool, evidence, and review events.

The project is intentionally presented as a learning implementation rather than a production-ready automation platform.

## Install

Requires Node.js 20 or newer and either an available CLI Agent or an API Agent configured from the Dashboard.

```bash
npm install --global runharness
cd your-project
runharness
```

pnpm is also supported:

```bash
pnpm add --global runharness
```

## Commands

```bash
runharness                         # open the TUI
runharness --web                   # open the TUI and Dashboard
runharness --web --port 8888       # require a local Runtime port
runharness -p "fix failing tests"  # run without the interactive TUI
runharness agents                  # inspect Agent routes
runharness data                    # inspect project data size
runharness clean                   # remove this project's data
```

Use `/help` inside the TUI for Session, Run, Continue, Steer, permission, workspace, image, and delivery commands.

## Boundaries

- A Session is recoverable; every user submission creates a Run with a terminal state.
- In-place work edits the project directly. Isolated work requires inspect/apply/discard.
- The Dashboard is a control plane for the Runtime owned by the TUI.
- RunHarness only makes hard permission guarantees for actions it directly controls.
- Local project data is stored under `~/.runharness/projects/<project-hash>`.

Source, architecture, screenshots, and development instructions are available at https://github.com/yellinzero/RunHarness.
