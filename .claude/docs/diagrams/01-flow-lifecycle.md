# Flow lifecycle

Every user-launchable workflow is a `FlowManifest` entry in `src/application/registry.ts`.
The CLI command builder, the TUI menu, and the launcher all read from that one array — add
a flow by appending one entry (`pnpm gen:flow <name>` to scaffold).

## From a click to a running flow

```mermaid
sequenceDiagram
    actor User
    participant UI as TUI menu / CLI command
    participant Registry as registry.ts
    participant Launch as launch/&lt;flow&gt;.ts
    participant Factory as flows/&lt;flow&gt;/flow.ts
    participant Runner as chain/run/runner.ts
    participant Bus as EventBus
    participant Sinks as TUI · chain.log · console

    User->>UI: pick flow
    UI->>Registry: read FlowManifest + triggers
    Registry-->>UI: gate decision (allow / why-disabled)

    UI->>Launch: launchXxx(ctx)
    Launch->>Factory: createXxxFlow(deps, opts)
    Factory-->>Launch: Element&lt;TCtx&gt;

    Launch->>Runner: createRunner({ id, element, initialCtx })
    Runner->>Runner: runWithSession(id, …)
    Runner->>Factory: element.execute(...)

    loop each step (leaf / sequential / loop / guard)
        Factory->>Bus: ChainStarted · ChainStep* · ChainCompleted
        Bus->>Sinks: subscriber fan-out
    end

    Sinks-->>User: live updates
```

## Where each piece lives

| Layer    | Path                                         | Owns                                                                            |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Registry | `src/application/registry.ts`                | One `FlowManifest` per flow; pre-launch trigger predicates.                     |
| Launcher | `src/application/ui/shared/launch/<flow>.ts` | Wiring `AppDeps` into the flow's slim `<Flow>Deps`, kicking off `createRunner`. |
| Factory  | `src/application/flows/<flow>/flow.ts`       | `createXxxFlow(deps, opts) → Element<TCtx>` — the chain composition.            |
| Runner   | `src/application/chain/run/runner.ts`        | Lifecycle, session scoping, event emission, replay buffer.                      |

`FlowTriggers` (the pre-launch predicates that gate the TUI menu) are described in
`.claude/docs/ARCHITECTURE.md` § Flow registry — they're a small struct, not a diagram.
