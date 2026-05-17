# Module layout

Four-module Clean Architecture. Dependencies point one way; `domain` and `business` are
pure (no I/O-bearing `node:*`). ESLint `no-restricted-imports` in `eslint.config.ts`
enforces every direction.

```mermaid
flowchart TB
  subgraph application["application/ (composition root + chain framework + UI)"]
    direction TB
    bootstrap["bootstrap/<br/>wire() · storage-paths · runtime-sinks"]
    flows["flows/&lt;flow&gt;/<br/>create-sprint · refine · plan · ideate · readiness ·<br/>implement · review · doctor · settings · export-* · create-pr · …"]
    chain["chain/<br/>element · build/{leaf,sequential,loop,guard} · run/runner"]
    session["session/<br/>AsyncLocalStorage scope"]
    ui["ui/{cli,tui}/<br/>Commander commands · Ink TUI"]
    registry["registry.ts<br/>FlowManifest[] — single source of truth"]
  end

  subgraph integration["integration/ (concrete adapters)"]
    direction TB
    integ_ai["ai/{providers,prompts,signals,skills,readiness}/<br/>sibling-isolated; cross-sibling → _engine/"]
    integ_persist["persistence/&lt;aggregate&gt;/<br/>project · sprint · sprint-execution · task · settings"]
    integ_obs["observability/<br/>InMemoryEventBus · sinks (console, file)"]
    integ_io["io/<br/>git-runner · shell-script-runner · file-locker · atomic write"]
    integ_scm["scm/<br/>gh · glab"]
  end

  subgraph business["business/ (use cases + ports — pure, no I/O node:*)"]
    direction TB
    biz_uc["use case modules<br/>project · sprint · sprint/views · ticket · task ·<br/>feedback · settings · version"]
    biz_ports["ports<br/>observability · scm · io · interactive"]
  end

  subgraph domain["domain/ (entities + values + repository interfaces — pure)"]
    direction TB
    dom_entity["entity/<br/>Project · Sprint · SprintExecution · Task · Ticket"]
    dom_value["value/<br/>SprintId · TaskId · AbsolutePath · IsoTimestamp · …<br/>+ value/error/ (DomainError class hierarchy)"]
    dom_repo["repository/&lt;aggregate&gt;/<br/>composite + _base/ slim sub-ports<br/>(FindById · Save · Remove)"]
    dom_signal["signal.ts<br/>HarnessSignal discriminated union"]
    dom_result["result.ts<br/>the only typescript-result re-export point"]
  end

  application --> integration
  application --> business
  application --> domain
  integration --> business
  integration --> domain
  business --> domain

  classDef pure fill:#e8f4f0,stroke:#2d6a4f
  classDef io fill:#fff3e0,stroke:#d97706
  classDef app fill:#e7f0ff,stroke:#1d4ed8
  class domain,business pure
  class integration io
  class application app
```

## Layer rules (enforced by ESLint)

| Layer          | May import from           | I/O-bearing `node:*` |
| -------------- | ------------------------- | -------------------- |
| `domain/`      | nothing outside `domain/` | ❌ banned            |
| `business/`    | `domain/` only            | ❌ banned            |
| `integration/` | `domain/` + `business/`   | ✅ allowed           |
| `application/` | anywhere                  | ✅ allowed           |

Pure `node:*` modules (`node:path`, `node:url`, `node:util`, `node:assert`, `node:crypto`)
are allowed in every layer.

## Other fenced rules

- **No `class` outside `src/domain/value/error/`** — entities and use cases are interfaces +
  factory functions.
- **No barrel `index.ts` files** — `export *` is banned; every import names what it pulls in.
- **Sibling-isolation** under `integration/ai/<concept>/` (providers, signals, prompts,
  readiness, skills), `business/<module>/`, and `application/flows/<flow>/`. Cross-sibling
  access goes through a shared `_engine/` sub-namespace.
- **Port-shaped types** (`*Port`, `*Adapter`, `*Provider`, `*Sink`, `*Loader`, `*Probe`, …)
  MUST live in `_engine/`.
- **Business consumes slim sub-ports**, not composite `*Repository` types. Composite types
  satisfy the slim ones; the composition root wires them.

See `.claude/docs/ARCHITECTURE.md` for the full module inventory and
`eslint.config.ts` for the concrete fence rules.
