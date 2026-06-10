# RalphCTL — Architecture

Function-first Clean Architecture with a chain-of-responsibility framework. For acceptance criteria, see
[REQUIREMENTS.md](./REQUIREMENTS.md). For the chain framework reference, see [KERNEL-DESIGN.md](./KERNEL-DESIGN.md).

## Why this shape

The application is structured as four strictly-layered modules. Use cases are plain functions
(`(props) => Promise<Result<Output, DomainError>>`) — no class instances, no constructor injection, no `this`.
Chains compose use cases into workflows; the chain framework is the orchestration layer, not business logic.

Every workflow ("flow") declares itself once in `src/application/registry.ts` as a `FlowManifest`. The CLI command
builder, the TUI menu, and the launch logic all consume from the same array. Adding a flow is one append — there
is no scattered index file or per-flow boilerplate fork.

## Module layout

```
src/
├── domain/        ← entities, value objects, errors, repository interfaces, signal types
├── business/      ← use cases (function factories) + observability + SCM + version ports
├── integration/   ← adapters: AI providers / prompts / signals / skills / readiness probes,
│                    persistence, observability sinks, SCM (gh/glab), version-check, IO helpers
└── application/   ← composition root, chain framework, flow registry + flows, runner + session,
                     CLI + Ink TUI
```

Strict layering — dependencies point one way:

```
application → integration → business → domain
```

Both `domain/` and `business/` are pure: they cannot import I/O-bearing `node:*` modules (`node:fs`,
`node:child_process`, `node:http`, …). Pure modules (`node:path`, `node:url`, `node:util`, `node:assert`,
`node:crypto`) are allowed. `integration/` is where I/O lives. `application/` is the only layer that may import
from anywhere.

ESLint `no-restricted-imports` (in `eslint.config.ts`) enforces every direction. The same config enforces:

- **No `class` outside `src/domain/value/error/`** — entities and use cases are interfaces + standalone functions.
- **No barrel files anywhere under `src/`** — every import names what it pulls in directly. `export *` is banned.
- **Sibling-isolation in `integration/ai/<concept>/`** — each per-tool / per-variant adapter directory is
  independent. Cross-sibling reach goes through a shared `_engine/` sub-namespace (or `_partials/` for prompts).
  Applies to `prompts/<flow>/`, `providers/<tool>/`, `readiness/<tool>/`, `skills/<source>/`; per-signal Zod schemas are
  isolated under `contract/_engine/signals/<kind>/`.
- **Port-shaped names live in `_engine/`** — interfaces / type aliases named `*Port`, `*Adapter`, `*Provider`,
  `*Sink`, `*Loader`, `*Probe`, `*Reader`, `*Writer`, `*Renderer`, `*Detector` must be declared in a concept's
  `_engine/` sub-namespace. Factory inputs named `*Deps` are exempt.
- **Business use cases consume slim sub-ports**, not composite `*Repository` interfaces. The composition root
  wires the composite to the use case as a slim port (`FindById`, `Save`, `Remove`, …) under
  `domain/repository/_base/`.
- **Sibling-isolation in `business/<module>/`** — each business sub-domain (`project`, `sprint`, `ticket`,
  `task`, `feedback`, …) is independent; cross-module sharing goes through `_engine/` or `_shared/`. The single
  universal cross-cutting exception is `business/observability/` — Logger and EventBus are infra-shaped ports
  every sibling consumes.
- **Sibling-isolation in `application/flows/<flow>/`** — flows compose port-level vocabulary only; bootstrap
  selects the concrete provider / probe / skill adapter. Meta-flows under `application/flows/_meta/` may import
  any sibling flow.
- **`*Output` types are the success-side data shape**, not the `Result` envelope. Use
  `Result<FooOutput, ErrorUnion>` in the function signature.

## Bounded contexts (aggregates)

| Aggregate root      | Sub-files on disk             | Repository interface        |
| ------------------- | ----------------------------- | --------------------------- |
| **Project**         | `projects/<id>.json`          | `ProjectRepository`         |
| **Sprint**          | `sprints/<id>/sprint.json`    | `SprintRepository`          |
| **SprintExecution** | `sprints/<id>/execution.json` | `SprintExecutionRepository` |
| **Task** (set)      | `sprints/<id>/tasks.json`     | `TaskRepository`            |
| **Settings**        | `config/settings.json`        | `SettingsRepository`        |

`Sprint` is split into three sibling on-disk files. `sprint.json` is the planning aggregate (tickets,
requirements, status, project reference). `execution.json` carries the runtime audit — branch name, PR URL,
per-repo setup-script timestamps. `tasks.json` is the canonical task list — the file the chain runner rewrites
on every settlement. The split keeps planning mutations isolated from execution-time writes; corrupting the task
list does not lose the sprint plan.

`Repository` is **nested inside `Project`** as a value object — not its own aggregate. Project carries an array
of repositories (each with `setupScript`, `verifyScript`, `verifyTimeout`, optional `verifyGates` (`VerifyGate[]` —
per-module `{ pathPrefix, command, timeoutMs? }` gates; wins over `verifyScript` when present and non-empty),
optional skill/script hints); mutating a repo goes through `ProjectRepository.save()`.

`Ticket` is nested inside `Sprint` (status flips `pending → approved` during refine).

## Chain framework

> Visual: [diagrams/00-chain-framework.md](./diagrams/00-chain-framework.md)

The `Element` interface plus four factory functions under `src/application/chain/`:

- `element.ts` — the `Element<TCtx>` interface every primitive implements. Carries `name`, optional `label`
  (human-friendly display string for UI surfaces — see below), optional `children` (for composite walk), and
  `execute(ctx, signal?, onTrace?): Promise<ElementResult<TCtx>>`.
- `build/leaf.ts` — `leaf(name, { useCase, input, output }, opts?)`. The only seam to a business use case.
  `input` projects ctx → use-case input; `output` merges use-case output → new ctx. Optional `opts.label`
  sets a human-friendly display label on the element and every `TraceEntry` it emits — `name` stays the
  canonical identifier; the TUI rail renders `label` when present and falls back to `name`.
- `build/sequential.ts` — `sequential(name, [elements])`. Threads ctx; aborts remaining on first failure.
- `build/loop.ts` — `loop(name, body, opts)`. Generator-evaluator primitive. `shouldContinue` (pre-iteration)
  and `shouldStop` (post-iteration) predicates exit naturally; `maxIterations` (default 1000) is a hard cap.
  Hitting the cap is an ok-return — callers distinguish budget exhaustion from natural termination via ctx.
- `build/guard.ts` — `guard(name, predicate, body)`. Skips the body when `predicate(ctx)` returns false; emits
  a `skipped` trace entry.

**No `retry` or `onError` decorators** — branching belongs inside a use case or a sub-chain the caller selects.
Retry on rate-limits is an adapter concern (`IterationConfig.rateLimitRetries` on the headless provider wrapper).

The `ChainRunner` (`src/application/chain/run/runner.ts`) wraps one `Element.execute()` call with a status
machine (`idle → running → completed | failed | aborted`) and an event stream
(`started | step | completed | failed | aborted`). Late subscribers added after a terminal state receive a
synthetic replay of every step entry plus the matching terminal event — UI re-attach is lossless. The trace is
ring-buffered at `MAX_TRACE_ENTRIES = 5_000` to bound the per-runner memory footprint on multi-task runs.

**Parallel task execution sits above the primitives, not inside them.** When
`settings.concurrency.maxParallelTasks > 1`, the implement flow dispatches through `runWaves`
(`src/application/chain/run/wave-scheduler.ts`) instead of the serial queue: tasks are grouped into
dependency waves (Kahn-by-level over `Task.dependsOn`), each wave's tasks run concurrently up to the cap
(`flows/implement/parallel-element.ts`), and waves stay strictly sequential. Each task runs in its own git
worktree (`<sprintDir>/worktrees/wt-<taskId>`, `flows/implement/wave-branch.ts`) with a fresh `setupScript`;
commits fold back onto the single shared sprint branch through one serialised in-process queue
(`flows/implement/merge-wave.ts`), so a parallel sprint still lands as one PR. `maxParallelTasks === 1`
(the default) flattens the waves into the serial queue — byte-for-byte the prior behaviour.

See [KERNEL-DESIGN.md](./KERNEL-DESIGN.md) for the full contract.

## Session scoping

`src/application/session/session.ts` wraps every chain execution in an `AsyncLocalStorage`-backed scope
(`runWithSession(sessionId, fn)`). Inside any async work spawned during the chain — including deep inside
provider adapters that don't know which chain they're in — `currentSessionId()` returns the owning chain's id.
The Logger and signal sink ports use this to tag every emitted record with the session, so the TUI can route
streams without explicit threading. Outside any chain (one-shot CLI commands, doctor checks),
`currentSessionId()` returns `undefined` and downstream consumers treat the stream as untagged.

## Use cases (`src/business/<module>/`)

Every business operation is a **function factory** with the shape:

```ts
const createDoFoo = (deps: DoFooDeps): UseCase<FooInput, FooOutput> => ({
  execute: async (input, signal?) => {
    /* ... */
  },
});
```

No class instances. The factory closes over its slim-port dependencies; the returned object has only `execute`.
Composition root constructs the factory at startup; chain leaves invoke `execute` via the `leaf` primitive.

Layout (one module per business sub-domain, sibling-isolated):

```
business/
├── project/           ← createProject, listProjects, addRepository, …
├── sprint/            ← createSprint, planSprint, transitionToReview, transitionToDone, …
├── sprint/views/      ← read-only views: sprint progress, requirements export, context export
├── ticket/            ← addTicket, refineTicket, removeTicket, …
├── task/              ← createTasks, updateTask, markBlocked, recordEvaluation, …
├── feedback/          ← applyFeedback (review flow body)
├── settings/          ← loadSettings, updateSettings
├── version/           ← cli-metadata, version-check, version-checker (npm poll)
├── scm/               ← issue-fetcher / issue-pusher / pull-request-creator ports
├── interactive/       ← interactive prompt port + InteractiveQueue
├── io/                ← write-file port (atomic + non-atomic shapes)
└── observability/     ← logger / event-bus / event-bus-logger / events / sink
```

## Ports

Service ports live under `business/<module>/` (one folder per cross-cutting concern). Repository interfaces live
in `domain/repository/<aggregate>/`.

| Port                                                  | Folder                              | Concrete adapter                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Logger` + `Sink`                                     | `business/observability/`           | `createEventBusLogger` (re-published as `LogEvent`)                                                                                                                         |
| `EventBus`                                            | `business/observability/`           | `InMemoryEventBus` (`integration/observability/`)                                                                                                                           |
| `HeadlessAiProvider`                                  | `integration/ai/providers/_engine/` | `claude` / `copilot` / `codex` adapters under `providers/<tool>/`                                                                                                           |
| `InteractiveAiProvider`                               | `integration/ai/providers/_engine/` | same per-tool adapters (interactive entrypoint)                                                                                                                             |
| `HarnessSignalSink`                                   | `business/observability/`           | file sinks under `integration/observability/sinks/`                                                                                                                         |
| `TemplateLoader`                                      | `integration/ai/prompts/_engine/`   | `FsTemplateLoader` — dev: src tree, bundled: `dist/`                                                                                                                        |
| `ReadinessProbe`                                      | `integration/ai/readiness/_engine/` | per-tool probes under `readiness/<tool>/`                                                                                                                                   |
| `SkillsAdapter` + `SkillSource`                       | `integration/ai/skills/_engine/`    | per-tool adapter + bundled / operator / project source; `parseSkill` extracts a `Skill` from a `SKILL.md`; `checkSkillContract` validates against six harness rules (S1–S6) |
| `GitRunner` / `ShellScriptRunner`                     | `integration/io/`                   | `createGitRunner` / `createShellScriptRunner`                                                                                                                               |
| `WriteFile` (port) + `FileLocker` (adapter)           | `business/io/` / `integration/io/`  | atomic write helper / `createFileLocker`                                                                                                                                    |
| `IssueFetcher` / `IssuePusher` / `PullRequestCreator` | `business/scm/`                     | `gh` / `glab` shell wrappers under `integration/scm/`                                                                                                                       |
| `VersionChecker`                                      | `business/version/`                 | `createNpmVersionChecker` (`integration/version/`)                                                                                                                          |

## Repository interfaces (`src/domain/repository/`)

Per-aggregate. Each composite repository declares the full CRUD surface but business code does not import it
directly — use cases depend on **slim sub-ports** under `domain/repository/_base/` so the dependency surface of
each use case is legible:

```ts
// domain/repository/_base/
interface FindById<Id, Entity> { findById(id: Id): Promise<Result<Entity | null, …>>; }
interface Save<Entity>         { save(entity: Entity): Promise<Result<void, …>>; }
interface Remove<Id>           { remove(id: Id): Promise<Result<void, …>>; }
// ...
```

A use case declares `Deps = { sprints: FindById<SprintId, Sprint> & Save<Sprint> }` and the composition root wires
the composite `SprintRepository` (which already satisfies both sub-interfaces) as that prop. ESLint blocks
business code from importing composite `*Repository` types.

Sibling-isolation: each aggregate's repository folder (`sprint/`, `task/`, `project/`, `settings/`) is independent;
shared abstractions live under `_base/`.

## Composition root

```
application/bootstrap/
├── wire.ts                ← createAppDeps via wire(opts: WireOptions): AppDeps
├── storage-paths.ts       ← resolveStoragePaths() + storagePathsFromRoot(absPath);
│                            StoragePaths carries appRoot / dataRoot / configRoot / stateRoot /
│                            locksRoot / runsRoot / memoryRoot / operatorSkillsRoot
├── runtime-sinks.ts       ← AppSinks (HarnessSignalSink, …)
├── provider-factory.ts    ← createAiProvider({ harnessConfig, eventBus, spawn? } & ({ flow, ai } | { row }))
├── interactive-provider-factory.ts
└── legacy-layout-detector.ts  ← v0.6.x layout detector (RALPHCTL_SKIP_LEGACY_CHECK bypass)
```

(Default settings live in `src/business/settings/defaults.ts`; `IterationConfig` is declared in
`src/application/chain/run/iteration-config.ts`.)

`wire(opts)` returns the `AppDeps` graph — every concrete adapter, in one pure object. Tests construct one from
a tmpdir via `storagePathsFromRoot(tmpDir)` so no test ever touches `~/.ralphctl/`. Production resolves real
paths via `resolveStoragePaths()` and calls `wire()` with them.

`AppDeps` is the type the typechecker uses to prove "every port the app needs is actually wired" at the bootstrap
boundary. Each flow declares its own slim `<Flow>Deps` interface that's a subset of `AppDeps` — reading a flow
factory's signature tells you exactly which ports the workflow depends on.

`AppDeps.eventBus` is a single in-memory bus per `wire()` call. Bus state isolates between concurrent app
instances. Adapters publish structured `AppEvent`s:

```ts
ChainStarted |
  ChainStepStarted |
  ChainStepCompleted |
  ChainStepFailed |
  ChainCompleted |
  ChainFailed |
  ChainAborted |
  TaskAttemptStarted |
  TaskAttemptEvaluated |
  TaskRoundStarted |
  FeedbackRoundApplied |
  TokenUsageEvent |
  BannerShowEvent |
  BannerClearEvent |
  MemoryPressureEvent |
  ChainLogDegradedEvent |
  HarnessSignalEvent |
  AiSignalEvent |
  ModelEscalatedEvent |
  LogEvent;
```

TUI panels subscribe for the live signal stream. The optional `<sprintDir>/events.ndjson` sink
(`integration/observability/sinks/file-log-sink.ts`) also subscribes when `RALPHCTL_DEBUG_TRACE=1` is set —
no-op factory otherwise. The same bus is the fan-out point for any future telemetry adapter. (`progress.md`
is not bus-driven — the `progress-journal` leaf appends to it directly from per-attempt ctx state.)

`AppDeps.logger` is created via `createEventBusLogger({ eventBus, clock: IsoTimestamp.now })` — every
`logger.info(...)` publishes a `LogEvent` AppEvent. Console sinks, file appenders, and TUI tail panels all
subscribe to the same stream.

## Flow registry (`src/application/registry.ts`)

> Visual: [diagrams/01-flow-lifecycle.md](./diagrams/01-flow-lifecycle.md)

The single source of truth for "what flows exist". Each entry is a `FlowEntry` carrying a `FlowManifest`:

```ts
interface FlowManifest {
  readonly id: string; // stable kebab-case identifier
  readonly title: string; // shown in TUI menu / CLI help
  readonly description: string;
  readonly canBackground: boolean;
  readonly triggers: FlowTriggers; // pre-launch readiness predicates
}
```

`FlowTriggers` declares the conjunction of conditions that gate a flow: `requiresProject`,
`currentSprintStatus`, `minPendingTickets`, `minApprovedTickets`, `minResumableTasks`. Empty triggers means
"always available". The TUI evaluates triggers against the current session state to enable / disable menu
entries and surface a human-readable hint when a flow isn't ready.

Concrete flow factories live next to the manifest in each flow folder (`src/application/flows/<flow>/`) and
are imported by the launcher (`application/ui/shared/launch/<flow>.ts`) or the CLI command
(`application/ui/cli/commands/<flow>.ts`).

### Flows and their nature

| Flow id                    | Shape    | CLI command                   | Notes                                                                                                |
| -------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `create-sprint`            | chain    | no                            | Interactive prompts; TUI only                                                                        |
| `add-tickets`              | chain    | no                            | Interactive loop; TUI only                                                                           |
| `refine`                   | chain    | no                            | Hands the terminal to the AI CLI; TUI only                                                           |
| `plan`                     | chain    | no                            | Interactive AI handoff; TUI only                                                                     |
| `ideate`                   | chain    | no                            | Interactive AI handoff; TUI only                                                                     |
| `readiness`                | chain    | no                            | Multi-step with confirm gates; TUI only                                                              |
| `detect-scripts`           | chain    | no                            | Setup/verify script discovery; TUI only                                                              |
| `detect-skills`            | chain    | no                            | Skill discovery; TUI only                                                                            |
| `implement`                | chain    | no                            | Genuinely needs the chain (gen-eval + retry)                                                         |
| `review`                   | chain    | no                            | Apply-feedback loop; TUI only                                                                        |
| `close-sprint`             | use-case | yes (`sprint close`)          | review → done transition                                                                             |
| `export-context`           | use-case | yes                           | Render harness-context markdown                                                                      |
| `export-requirements`      | use-case | yes                           | Render approved-ticket requirements markdown                                                         |
| `create-pr`                | use-case | yes                           | Open PR via `gh` / `glab`, persist URL on execution                                                  |
| `doctor`                   | use-case | yes                           | Environment health check                                                                             |
| `settings`                 | use-case | yes (`settings show` / `set`) | Per-key read/write                                                                                   |
| `remove-ticket`            | use-case | yes (`ticket remove`)         | Routes via `sprint-detail` view when launched from Flows                                             |
| `add-ticket` (no registry) | use-case | yes (`ticket add`)            | CLI path + `a` shortcut → `add-ticket` wizard; removed from Flows menu (superseded by `add-tickets`) |
| —                          | CLI-only | `runs list` / `runs prune`    | Inspect and prune per-run forensic artifacts                                                         |

CLI surface is deliberately smaller than v0.6.x — the interactive chains stay TUI-only by design. Run
`ralphctl <command> --help` for flag-level detail on the CLI commands.

## Validation strategy

- **Value objects** (`src/domain/value/`) — branded types with smart constructors that return `Result<T, E>`.
  Instances are always valid. Examples: `SprintId`, `TaskId`, `TicketId`, `ProjectId`, `Slug`, `AbsolutePath`,
  `IsoTimestamp`. Zod is used inside the smart constructor where a format check helps; otherwise plain runtime
  predicates.
- **Entities** (`src/domain/entity/`) — trust their own invariants. No Zod inside `Sprint`, `Project`, `Task`,
  `Ticket`, `Repository`. Mutators return new instances; entities are structurally immutable.
- **Serialization boundary** — Zod schemas in `src/integration/persistence/<aggregate>/<aggregate>.schema.ts`
  validate JSON when reading/writing files. Round-trip type safety; on-disk corruption surfaces as a typed
  `ParseError`.
- **Settings boundary** — `src/domain/entity/settings.ts` declares the `SettingsSchema` Zod object; the
  persistence adapter reuses it for round-trip parsing. A malformed file surfaces as `ParseError`, not a
  half-decoded record. The schema carries `schemaVersion` for forward-migration when the on-disk shape changes.
- **External input boundary** — Zod for AI output parsing (`signals.json`, planning output).

## Result types

`Result<T, E>` and `AsyncResult<T, E>` come from `typescript-result`, but every consumer imports from
`src/domain/result.ts` — the canonical re-export point. The underlying library may only be imported by that one
file; ESLint enforces it.

Use cases return `Result<T, DomainError>`. Throws are reserved for programmer errors (e.g. ctx-shape violations
inside a leaf `input` / `output` projection). Persistence-layer functions may throw domain errors at the bottom
of the stack — the leaf or use-case wrapping them catches and converts to `Result`.

## Storage layout

```
~/.ralphctl/                      ← override with RALPHCTL_HOME
├── config/
│   └── settings.json                ← user-configurable settings (per-flow models, provider, log level, …)
├── skills/                          ← operator drop-in skills root (operatorSkillsRoot); operator-authored,
│   ├── claude/<name>/SKILL.md          not created by ensureStorageRoots; missing dir = no operator skills
│   ├── copilot/<name>/SKILL.md
│   └── codex/<name>/SKILL.md
├── data/
│   ├── projects/
│   │   └── <project-id>.json
│   ├── memory/
│   │   └── <project-id>/
│   │       └── learnings.ndjson     ← append-only per-attempt learning ledger (procedural memory); each LearningRecord carries { v, id, text, context?, appliesTo?, repo, repoName, taskKind, sprintId, taskId, timestamp, promotedAt }
│   └── sprints/
│       └── <sprint-id>/
│           ├── sprint.json          ← planning: tickets, requirements, status, project ref
│           ├── execution.json       ← runtime audit: branch, PR URL, structured setup-run history
│           ├── tasks.json           ← task list with status, attempts, evaluations
│           ├── events.ndjson        ← optional EventBus trace, only when RALPHCTL_DEBUG_TRACE=1
│           ├── progress.md          ← append-only journal; one section appended per settled attempt
│           ├── refinement/<ticket-slug>/  ← per-ticket sandbox for refine AI session
│           │   ├── prompt.md
│           │   └── requirements.md  ← AI writes; harness reads back
│           ├── plan/<run-slug>/           ← sandbox for plan AI session
│           │   ├── prompt.md
│           │   └── signals.json
│           ├── ideate/                    ← sandbox for ideate AI session
│           ├── implement/<task-id>/       ← per-task sandbox
│           │   ├── prompt.md
│           │   └── rounds/<N>/                   ← done-criteria.md was removed in audit-[05]; criteria live on Task.verificationCriteria and in each round prompt.md
│           │       ├── outcome.md              ← settle-attempt verdict (written after settlement)
│           │       ├── generator/
│           │       │   ├── prompt.md           ← rendered generator prompt (written before spawn)
│           │       │   ├── signals.json
│           │       │   └── session-id.txt
│           │       └── evaluator/
│           │           ├── prompt.md           ← rendered evaluator prompt (written before spawn)
│           │           ├── signals.json
│           │           └── session-id.txt
│           ├── feedback.md            ← human review feedback input (read by the review flow)
│           ├── distill/               ← learning-distill AI session sandbox (opt-in at close)
│           └── review/                ← apply-feedback per-round forensics
└── state/
    └── locks/
        └── repo-<worktree-hash>.lock/ ← cross-process advisory lock directory (one per sprint, keyed by sha1 of the sprint dir path — implement and review share the same key)
```

Path resolution lives in `src/application/bootstrap/storage-paths.ts` (`resolveStoragePaths`,
`storagePathsFromRoot`, `ensureStorageRoots`). On-disk path helpers for the sprint subtree live in
`src/integration/persistence/storage.ts`.

The `RALPHCTL_HOME` env var, when set to an absolute path, replaces the entire `<home>/.ralphctl` prefix.
Used by integration tests that spawn real subprocesses, and by users who want a non-default data location.

## Data Models

> Visuals: [diagrams/02-sprint-lifecycle.md](./diagrams/02-sprint-lifecycle.md) ·
> [diagrams/03-task-lifecycle.md](./diagrams/03-task-lifecycle.md)

Canonical entity shapes live in `src/domain/entity/<name>.ts` — immutable interfaces with `Result`-returning
smart constructors. Read the source for the field list; this section names each aggregate's identity, lifecycle,
and the non-obvious mutators.

- **`Project`** (`project.ts`) — identified by `ProjectId`; carries an array of `Repository` value objects (each
  with optional `setupScript`, `verifyScript`, `verifyTimeout`, `verifyGates` (`VerifyGate[]` — per-module
  `{ pathPrefix, command, timeoutMs? }` gates proposed by `detect-scripts`; wins over `verifyScript` when
  present and non-empty), `setupSkill`, `verifySkill`, and `suggestedSkills` — names persisted by
  `offerSkillSuggestionsLeaf` in the readiness flow).
- **`Sprint`** (`sprint.ts`) — identified by `SprintId`; lifecycle `draft → planned → active → review → done`; carries
  `projectId`, nested `Ticket[]`, `affectedRepositories` (absolute paths). Mutators: `addTicket`, `refineTicket`,
  `removeTicket`, `planSprint(draft → planned)`, `activate`, `transitionToReview`, `transitionToDone`.
- **`SprintExecution`** (`sprint-execution.ts`) — identified by the parent `SprintId`; carries `branch`,
  `pullRequestUrl`, `setupRanAt` (array of `SetupRun` — one structured entry per repo per chain run,
  outcome: `success` / `failed` / `spawn-error` / `skipped`). Separate from `Sprint` so runtime-mutating
  fields don't collide with planning writes.
- **`Ticket`** (nested inside `Sprint`) — identified by `TicketId`; `requirementStatus: pending → approved`
  flipped by the refine flow.
- **`Task`** (`task.ts`) — identified by `TaskId`; status `todo | in_progress | done | blocked`; references
  `Sprint` via `ticketId` and DAG edges via `dependsOn` (array of `TaskId`; the planner emits them as
  `blockedBy` and `parseTaskList` resolves them onto `dependsOn`). Carries an `attempts[]` history — each
  `Attempt` has `evaluation`, `verification`, `attribution` (`clean` / `regressed` / `baseline-broken` /
  `fixed-baseline` from pre/post verify-script comparison), optional `abortCause` (`AbortCause` discriminated
  union), and optional `recoveryContext` (resume-from-aborted metadata). `BlockedTask` adds a structural
  `blockKind: 'upstream' | 'own'` discriminant — `'upstream'` when the `dependency-gate` parked the task
  because a prerequisite was not `done`; `'own'` for evaluator / verify / budget failures. New code reads
  `isUpstreamBlocked(task)` (checks `blockKind`) — never the `blockedReason` string prefix. Legacy
  `tasks.json` entries without `blockKind` are migrated at read time. Optional `extraDimensions` is the
  planner's per-task grading rubric beyond the four floor dimensions (Correctness / Completeness / Safety /
  Consistency). Optional `maxAttempts` overrides the global cap. Optional `escalatedFromModel` /
  `escalatedToModel` are stamped on first plateau-escalation.
- **`Settings`** — declared by `SettingsSchema` in `domain/entity/settings.ts`. Top-level fields:
  `schemaVersion` (currently `2`), `ai`,
  `harness: { maxTurns, maxAttempts, rateLimitRetries, plateauThreshold, escalateOnPlateau, escalationMap, skipPreVerifyOnFreshSetup }`,
  `logging: { level }`, `concurrency: { maxParallelTasks }`, `ui: { notifications: { enabled } }`,
  `developer: { showEvaluatorFailureUI }`. `ai` is a flat per-flow record: an optional global
  `ai.effort` plus one row per flow — `ai.{refine, plan, readiness, ideate, createPr}`, each
  `{ provider, model, effort? }`, and `ai.implement`, a nested `{ generator, evaluator }` pair
  where each role is its own `{ provider, model, effort? }` row. `provider` is one of
  `'claude-code' | 'github-copilot' | 'openai-codex'`.

## Harness Signals

Discriminated union declared at `src/domain/signal.ts`. Every AI-spawning leaf carries a
per-leaf `AiOutputContract` (`src/application/flows/<flow>/leaves/<leaf>.contract.ts`)
composed from Zod schemas under `src/integration/ai/contract/_engine/signals/<kind>/`. Adding
a signal kind = adding one schema file + updating the contracts that accept it.

On disk the AI writes one file per spawn: `<outputDir>/signals.json` with a `{ schemaVersion,
signals: [...] }` envelope. The harness reads + Zod-validates post-spawn via
`validateSignalsFile`, then renders operator-readable sidecars (`commit-message.txt`,
`evaluation.md`, `setup-skill.md`, ...) from the validated signals. Each contract carries a
`migrations[v]` chain so in-flight sprints written with an older shape upgrade transparently.

| Signal                                                   | Consumed by                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EvaluationSignal`                                       | Per-round critique persisted on the `Task.attempts[]` history                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TaskCompleteSignal`                                     | Per-task subchain transitions the task to `done` (after `verifyScript` passes)                                                                                                                                                                                                                                                                                                                                                                                |
| `TaskVerifiedSignal`                                     | Use case sets `verified` on the task entity                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TaskBlockedSignal`                                      | Use case transitions task to `blocked`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NoteSignal`                                             | Accumulated on `ctx.currentAttemptNotes` during the attempt; `progress-journal` renders the deduped list as the `### Notes` subsection of the journal entry. Also fans out as `HarnessSignalEvent` for live TUI panels (and `events.ndjson` when `RALPHCTL_DEBUG_TRACE=1`).                                                                                                                                                                                   |
| `LearningSignal`                                         | Same path → `ctx.currentAttemptLearnings` → `### Learnings` subsection. Each signal carries a required `text` (Insight) and optional `context` (when/why) / `appliesTo` (where); rendered as a bold Insight bullet with indented `Context:` / `Applies to:` sub-bullets (omitted when absent). The `LearningEntry` shape lives in `src/domain/signal.ts`; dedup via `dedupeLearnings` (`src/application/flows/implement/leaves/_shared/dedupe-learnings.ts`). |
| `ChangeSignal`                                           | Same path → `ctx.currentAttemptChanges` → `### Changes` subsection.                                                                                                                                                                                                                                                                                                                                                                                           |
| `DecisionSignal`                                         | Same path → `ctx.currentAttemptDecisions` → `### Decisions` subsection (audit-[07] replaced the old `decisions-log` sink / `decisions.log` file)                                                                                                                                                                                                                                                                                                              |
| `CommitMessageSignal`                                    | Used by `commit-task` leaf to author commit message                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SetupScriptSignal`                                      | `detect-scripts` flow persists on `Repository.setupScript`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `VerifyScriptSignal`                                     | `detect-scripts` flow persists on `Repository.verifyScript`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `VerifyGatesSignal`                                      | `detect-scripts` flow persists per-module `{ pathPrefix, command, timeoutMs? }` gates onto `Repository.verifyGates` (additive to `VerifyScriptSignal`; emitted for monorepo proposals only — single-module repos omit the signal; gates win over `verifyScript` when present and non-empty)                                                                                                                                                                   |
| `AgentsMdProposalSignal`                                 | `readiness` flow writes the provider-native context file (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md)                                                                                                                                                                                                                                                                                                                                            |
| `SetupSkillProposalSignal` / `VerifySkillProposalSignal` | `detect-skills` flow surfaces suggestions                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SkillSuggestionsSignal`                                 | `readiness` flow — `offerSkillSuggestionsLeaf` presents a human-gated install/scaffold step per suggested skill; accepted names persist on `Repository.suggestedSkills`                                                                                                                                                                                                                                                                                       |
| `ContextCompactedSignal`                                 | TUI renders a dedented separator marker in the signal stream at the compaction boundary                                                                                                                                                                                                                                                                                                                                                                       |

EventBus events emitted by the chain runner / adapters (not parsed from AI output): `ChainStarted`,
`ChainStepStarted`, `ChainStepCompleted`, `ChainStepFailed`, `ChainCompleted`, `ChainFailed`,
`ChainAborted`, `TaskAttemptStarted`, `TaskAttemptEvaluated`, `TaskRoundStarted`,
`FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShowEvent`, `BannerClearEvent`,
`MemoryPressureEvent`, `ChainLogDegradedEvent`, `HarnessSignalEvent`, `AiSignalEvent`,
`ModelEscalatedEvent`, `LogEvent`.

## Error Classes

All domain errors extend `DomainError` (`src/domain/value/error/domain-error.ts`) and carry a machine-readable
`code` plus optional `cause`. The error class is one of the few legitimate places `class` is allowed.

| Class               | Folder                | Cause                                                                  |
| ------------------- | --------------------- | ---------------------------------------------------------------------- |
| `NotFoundError`     | `domain/value/error/` | Aggregate (project / sprint / ticket / task) not found by id           |
| `ConflictError`     | `domain/value/error/` | Uniqueness or cardinality violation (e.g. duplicate slug, repo path)   |
| `InvalidStateError` | `domain/value/error/` | Operation invalid for the entity's current status                      |
| `ValidationError`   | `domain/value/error/` | Smart-constructor or schema validation failed (carries `field`/`path`) |
| `ParseError`        | `domain/value/error/` | JSON / output parser rejection                                         |
| `StorageError`      | `domain/value/error/` | Read/write failure in the persistence layer                            |
| `RateLimitError`    | `domain/value/error/` | AI process rate-limited (wraps spawn outcome)                          |
| `AbortError`        | `domain/value/error/` | User-initiated cancellation; propagates through chains                 |
| `ProbeError`        | `domain/value/error/` | Readiness probe rejection                                              |
| `MigrationGapError` | `domain/value/error/` | On-disk schemaVersion older than expected and no migration registered  |

## Exit Codes

The CLI does not centralise exit codes in a constants module. Commands set `0` on success and `1` on any
validation/execution error via `process.exitCode = 1` (`src/application/ui/cli/cli.ts`) or `process.exit(1)`
(`src/application/ui/cli/bootstrap.ts` and per-command actions). No SIGINT-specific (130) code is emitted.

## Terminal UI Layer (`src/application/ui/`)

Stock Ink + hand-rolled inline gradient renderer (no `@inkjs/ui`, no external gradient libraries). The TUI is
the primary surface — `ralphctl` with no args mounts the full app. CLI subcommands skip the Ink mount and run
against the bootstrap directly, emitting structured logs through the console sink.

```
application/ui/
├── cli/
│   ├── cli.ts                       ← Commander program builder
│   ├── bootstrap.ts                 ← wire() + sinks setup for one-shot commands
│   └── commands/<name>.ts           ← per-command flag definitions + Result-aware action
├── shared/
│   └── launch/<flow>.ts             ← chain launcher (creates runner, tees events.ndjson)
└── tui/
    ├── runtime/                     ← mount.tsx (alt-screen takeover) + use-event-bus.ts subscriber
    ├── theme/                       ← tokens.ts (single source of visual truth)
    ├── components/                  ← ViewShell, SectionStamp, ResultCard, FieldList, Spinner, …
    ├── prompts/                     ← InkPromptAdapter + per-kind components
    └── views/                       ← Home, Sprints, Sprint detail, Projects, Settings, Doctor,
                                       Sessions, Execute, Welcome, browse/, crud/
```

The mount path enters the **alt-screen buffer** (`CSI ? 1049 h`) and hides the cursor so ralphctl takes over the
terminal like vim/htop/less. Restoration is guaranteed via explicit exit +
`process.on('exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'uncaughtException')` safety nets.

Cross-cutting TUI features:

- **Persistent banner** + **help overlay** (`?`). The banner quote stabilises at module load so navigation
  doesn't jitter. `b` toggles banner compact ↔ full.
- **Centralised keyboard map** — all shortcuts in one table; the help overlay generates from the same source.
- **Multi-flow nav** — Tab / Shift+Tab cycle running flows, `Ctrl+1..9` direct-jump; `SessionsView` lists every
  runner with status + age.
- **Schema-driven settings panel** — rows iterate the `SettingsSchema`; the prompt kind is derived from value
  type. Edits save immediately.
- **Doctor view** — runs `runDoctor()` on mount; renders per-check status rows + an aggregate result card.
  `!` opens it from anywhere.
- **Execute view is responsive** — three-column (flow-steps rail / tasks-stream / context) at `xl` (≥180),
  two-column at `lg` (≥140), compact-rail at `md` (100–139), single-column below `md`. The rail is fixed
  28 cols below `xl`; at `xl`+ it grows fluidly up to 56 cols via `resolveRailWidth`. All width decisions use
  the named breakpoints (`sm 80 / md 100 / lg 140 / xl 180 / xxl 220`) from `theme/tokens.ts` — no
  hardcoded column literals. `StepTrace` renders `Element.label` when present; long labels are mid-truncated
  to fit the rail column budget. Global keys `g` (progress overlay), `y` (yank task summary), `b` (banner
  toggle), `P` (project picker), `S` (sprint picker). Execute-local: `j`/`k` card nav, `e` done-criteria,
  `c` cancel-scope picker (attempt vs flow). Task cards are collapsed by default.
- **`TokenBudgetCard`** and **`BaselineHealthCard`** in the context column subscribe to `TokenUsageEvent`
  and the `SetupRun` history respectively. **`StatusBanner`** (tiered `info`/`warn`/`error`) replaces the
  old `RateLimitBanner`. **`MultiFlowStrip`** renders concurrent session status above the tasks panel.
  **`EvaluatorFailurePanel`** is fixture-gated behind `settings.developer.showEvaluatorFailureUI`.
- **`ProgressOverlay`** (`g`) reads `progress.md` from disk on demand — no live tail, snapshot-on-open.
- **`CancelScopeOverlay`** (`c`) lets the operator cancel either the current AI attempt or the whole flow.
- **`glyphFor(signalKind)`** — adds shape-redundant glyphs for every signal kind under `NO_COLOR=1`.
- **`WindowedList` primitive** — `windowed-list.tsx` exports `computeListWindow`, `useListWindow`,
  `WindowedList`, and `OverflowRow`. Every long, scrollable, homogeneous list in the TUI mounts through
  this primitive; the prior `CardList` and `ListView` components are deleted. Id-based cursor (`getId`
  prop) survives item reorder and eviction. `ScrollRegion` now accepts `suppressArrows` — views that own
  a list cursor pass it to prevent double-handling of `↑/↓` / `PgUp`/`PgDn` at the page level.

For tokens / components / state surfaces / copy rules see [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md).

## Build & Distribution

Two-stage pipeline:

1. **`tsup`** compiles the TypeScript graph to `dist/cli.mjs`.
2. **`tsx scripts/build-assets.ts`** walks `src/integration/ai/prompts/<flow>/` and
   `src/integration/ai/skills/bundled/<name>/`, copies them into `dist/prompts/` and `dist/skills/`, and writes
   `dist/manifest.json` listing every staged asset.

Template / skill loading is dual-mode:

- **Dev (`tsx`)** — reads from `src/integration/ai/{prompts,skills}/`. `FsTemplateLoader` and `bundledSkillSource`
  detect mode via `import.meta.url`.
- **Bundled (`dist/cli.mjs`)** — reads from `dist/{prompts,skills}/`. Missing assets fail fast with a repair hint.

CI smoke-tests `node dist/cli.mjs --version` from arbitrary cwd plus a real `npm install` from the packed tarball.

## Future Work

- **Real-provider e2e** — every Claude / Copilot / Codex provider test uses a fake `spawn`. Vendor JSON-shape
  drift will surface here first. Same gap as v0.6.x; deferred.
- **Bundle-mode detection robustness** — `import.meta.url.endsWith('/cli.mjs')` would silently no-op if the
  published bin is renamed. Candidate replacement: `existsSync(<here>/manifest.json)`.
- **Cross-provider escalation** — plateau escalation today stays within a provider (e.g. Sonnet → Opus);
  switching providers mid-task carries auth/context/tool hazards and is deferred.
- **Learning-ledger retrieval / embeddings** — the distill step reads the full ledger (no retrieval engine).
  A vector index would let the ledger scale to multi-sprint histories.
