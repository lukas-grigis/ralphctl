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

Flow inventory (the 17 manifest entries) is in `.claude/docs/ARCHITECTURE.md` § Flow registry
and in the live `src/application/registry.ts`. `FlowTriggers` (the pre-launch predicates that
gate the TUI menu) is described in the same section — it's a struct, not a diagram.
