# Flow lifecycle

Every user-launchable workflow is a `FlowManifest` entry in `src/application/registry.ts`.
The CLI command builder, the TUI menu, and the launcher all read from that one array — add
a flow by appending one entry (use `pnpm gen:flow <name>` to scaffold the body).

## From registry to runner

```mermaid
flowchart TB
  user(["User launches a flow"]) --> surface{Surface}
  surface -->|TUI: menu pick| tuiLaunch["application/ui/shared/launch/&lt;flow&gt;.ts"]
  surface -->|CLI: subcommand| cliCmd["application/ui/cli/commands/&lt;flow&gt;.ts"]

  registry["application/registry.ts<br/>flowRegistry: FlowManifest[]"]
  triggers["FlowTriggers<br/>(requiresProject, currentSprintStatus,<br/>minPendingTickets, minApprovedTickets,<br/>minResumableTasks)"]

  registry -.gate.-> tuiLaunch
  triggers -.gate.-> tuiLaunch

  tuiLaunch --> factory
  cliCmd --> factory

  subgraph factory["application/flows/&lt;flow&gt;/flow.ts"]
    direction TB
    deps["&lt;Flow&gt;Deps<br/>(slim subset of AppDeps)"]
    body["createXxxFlow(deps, opts)<br/>returns Element&lt;TCtx&gt;"]
    deps --> body
  end

  factory --> runner

  subgraph runner["application/chain/run/runner.ts"]
    direction TB
    createRunner["createRunner({ id, element, initialCtx })"]
    sessionScope["runWithSession(id, …)<br/>AsyncLocalStorage"]
    exec["element.execute(ctx, signal, onTrace)"]
    createRunner --> sessionScope --> exec
  end

  exec --> bus["EventBus<br/>(ChainStarted → ChainStep* →<br/>ChainCompleted/Failed/Aborted)"]
  bus --> tuiUI[TUI live execute view]
  bus --> log["&lt;sprintDir&gt;/chain.log sink"]
  bus --> console[console LogSink]

  classDef ext fill:#fff3e0,stroke:#d97706
  classDef internal fill:#e7f0ff,stroke:#1d4ed8
  class user,tuiUI,console ext
  class registry,triggers,factory,runner,bus internal
```

## Flow inventory (from `registry.ts`)

| Flow id                        | Shape    | CLI? | What it does                                        |
| ------------------------------ | -------- | :--: | --------------------------------------------------- |
| `create-sprint`                | chain    |  ✗   | Interactive prompts; TUI only                       |
| `add-tickets`                  | chain    |  ✗   | Interactive loop; TUI only                          |
| `refine`                       | chain    |  ✗   | Per-ticket AI handoff; TUI only                     |
| `plan`                         | chain    |  ✗   | Interactive AI handoff; generates `tasks.json`      |
| `ideate`                       | chain    |  ✗   | Combines refine + plan in one AI session            |
| `readiness`                    | chain    |  ✗   | Writes provider-native context file (CLAUDE.md / …) |
| `detect-scripts`               | chain    |  ✗   | Setup / check script discovery                      |
| `detect-skills`                | chain    |  ✗   | Skill discovery                                     |
| `implement`                    | chain    |  ✗   | Genuinely needs the chain (gen-eval + retry)        |
| `review`                       | chain    |  ✗   | Apply-feedback loop                                 |
| `close-sprint`                 | use-case |  ✓   | `sprint close <id>` — review → done                 |
| `export-context`               | use-case |  ✓   | Render harness-context markdown                     |
| `export-requirements`          | use-case |  ✓   | Render approved-ticket requirements markdown        |
| `create-pr`                    | use-case |  ✓   | Open PR via `gh` / `glab`                           |
| `doctor`                       | use-case |  ✓   | Environment health check                            |
| `settings`                     | use-case |  ✓   | `settings show` / `set`                             |
| `ticket-add` / `ticket-remove` | use-case |  ✓   | CLI ticket mutators                                 |

**CLI surface is deliberately smaller than v0.6.x.** Interactive chains stay TUI-only by
design. The CLI exposes inspection + one-shot operations only. See `docs/api.md` (in the v2
source repo) for flag-level detail on the use-case commands.

## Triggers

```mermaid
flowchart LR
  triggers["FlowTriggers"]
  triggers --> rp["requiresProject:<br/>at least one project registered"]
  triggers --> css["currentSprintStatus:<br/>['draft' | 'active' | 'review' | 'done']"]
  triggers --> mpt["minPendingTickets:<br/>≥ N tickets with status='pending'"]
  triggers --> mat["minApprovedTickets:<br/>≥ N tickets with status='approved'"]
  triggers --> mrt["minResumableTasks:<br/>≥ N tasks in todo OR in_progress"]
```

Triggers are pre-launch readiness predicates. The TUI menu greys out flows whose triggers
aren't met and surfaces a one-line hint explaining the gap. Empty triggers means "always
available".
