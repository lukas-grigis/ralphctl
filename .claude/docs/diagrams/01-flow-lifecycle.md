# Flow lifecycle

Every user-launchable workflow is a `FlowManifest` entry in `src/application/registry.ts`.
The CLI command builder, the TUI menu, and the launcher all read from that one array — add
a flow by appending one entry next to its `manifest.ts` / `flow.ts` in
`src/application/flows/<flow>/`.

## From a click to a running flow

```mermaid
sequenceDiagram
    actor User
    participant UI as TUI menu / CLI command
    participant Registry as registry.ts
    participant Launch as launch/&lt;flow&gt;.ts
    participant Factory as flows/&lt;flow&gt;/flow.ts
    participant Runner as chain/run/runner.ts
    participant Bridge as observability/chain-runner-bridge.ts
    participant Bus as EventBus
    participant Sinks as TUI · events.ndjson · console

    User->>UI: pick flow
    UI->>Registry: read FlowManifest + triggers
    Registry-->>UI: gate decision (allow / why-disabled)

    UI->>Launch: launchXxx(ctx)
    Launch->>Factory: createXxxFlow(deps, opts)
    Factory-->>Launch: Element&lt;TCtx&gt;

    Launch->>Runner: createRunner({ id, element, initialCtx })
    Runner->>Runner: runWithSession(id, …)
    Runner->>Factory: element.execute(...)

    Note over Bridge: bridgeRunnerToEventBus — wired by the launcher
    Runner-->>Bridge: RunnerEvent · started
    Bridge->>Bus: chain-started (once)
    loop each step (leaf / sequential / loop / guard)
        Runner-->>Bridge: RunnerEvent · step
        Bridge->>Bus: chain-step-completed / chain-step-failed
        Bus->>Sinks: subscriber fan-out
    end
    Runner-->>Bridge: RunnerEvent · completed / failed / aborted
    Bridge->>Bus: chain-completed / chain-failed / chain-aborted (once)

    Sinks-->>User: live updates
```

## Where each piece lives

| Layer    | Path                                                   | Owns                                                                                                                             |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Registry | `src/application/registry.ts`                          | One `FlowManifest` per flow; pre-launch trigger predicates.                                                                      |
| Launcher | `src/application/ui/shared/launch/<flow>.ts`           | Wiring `AppDeps` into the flow's slim `<Flow>Deps`, kicking off `createRunner`.                                                  |
| Factory  | `src/application/flows/<flow>/flow.ts`                 | `createXxxFlow(deps, opts) → Element<TCtx>` — the chain composition.                                                             |
| Runner   | `src/application/chain/run/runner.ts`                  | Lifecycle, session scoping, internal `RunnerEvent` emission, replay buffer.                                                      |
| Bridge   | `src/application/observability/chain-runner-bridge.ts` | Subscribes to the runner's `RunnerEvent`s and republishes them as `EventBus` `AppEvent`s, tagging each with the flow's `flowId`. |

`FlowTriggers` (the pre-launch predicates that gate the TUI menu) are described in
`.claude/docs/ARCHITECTURE.md` § Flow registry — they're a small struct, not a diagram.
