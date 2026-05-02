# RalphCTL — Architecture

Five-module Clean Architecture with a chain-of-responsibility kernel. For acceptance criteria, see
[REQUIREMENTS.md](./REQUIREMENTS.md). For the chain framework reference, see [KERNEL-DESIGN.md](./KERNEL-DESIGN.md).

## Why this shape

The application is structured as five strictly-layered modules. The kernel chain framework is a first-class primitive
that orchestrates use cases — closer to a workflow engine (Camunda BPMN, Temporal) than a typical "pipeline"
abstraction. Chains are declarative, composable, and inspectable; every workflow has a step trace consumable by tests
and the TUI.

## Module layout

```
src/
├── kernel/        ← pure algorithms + chain-of-responsibility framework
├── domain/        ← entities, value objects, repository interfaces, signals, errors
├── business/      ← use cases (constructor-injected classes) + service ports
├── integration/   ← adapters: AI providers, persistence, external, signals, logging, UI prompts
└── application/   ← composition root, CLI, TUI, chain definitions, runtime, doctor
```

Strict layering — dependencies point one way only:

```
application → integration → business → domain
                                ↓        ↑
                                └── kernel
```

Both `domain/` and `kernel/` are pure, leaf-importable, zero-IO. `business/` may import from either. `integration/`
may import from `business/`, `domain/`, `kernel/`. `application/` is the composition root and may import from anywhere.

ESLint `no-restricted-imports` (in `eslint.config.js`) enforces every direction. No barrel `index.ts` files anywhere
under `src/` — every import points directly to the source module.

## Bounded contexts (aggregates)

| Aggregate root | Nested entities             | Repository          |
| -------------- | --------------------------- | ------------------- |
| **Project**    | Repositories                | `ProjectRepository` |
| **Sprint**     | Tickets                     | `SprintRepository`  |
| **Task**       | — (references Sprint by id) | `TaskRepository`    |

Aggregates are mutated through their root only. Editing a ticket goes through `SprintRepository.save()`, not a
separate `TicketRepository`. Invariants are enforced at the aggregate boundary.

Not domain elements:

- **Config** — application concern; lives in `src/application/config/`
- **Skills** — integration concern; lives in `src/integration/ai/skills/`

## Kernel — chain framework

The kernel owns the chain-of-responsibility framework. See [KERNEL-DESIGN.md](./KERNEL-DESIGN.md) for the full
contract.

Six concepts, one file each under `src/kernel/chain/`:

- **`Element<TCtx>`** — interface with one `execute(ctx, signal?) → Result<{ ctx, trace }, { error, trace }>` method.
  Every chain primitive implements this.
- **`Leaf`** — wraps a use case; the only place a chain meets business code (`Leaf` adapts
  `UseCase.execute(input) → Result<output>` into `Element.execute(ctx) → Result<ctx>`).
- **`Sequential`** — runs elements in order, threading the context. Composite is implicit — a sub-chain is just an
  `Element` passed where another `Element` would be.
- **`Parallel`** — fans elements out concurrently with a concurrency cap and a `failureMode` of `'fail-fast'` or
  `'collect-all'`. Used by `executeFlow` for per-task fan-out.
- **`Retry`** — decorator wrapping an element with a retry policy (`maxAttempts`, `backoff`, `retryOn` predicate).
- **`OnError`** — decorator catching errors that match `catchIf` and running a fallback element with the same context.

Conditionals are deliberately not a primitive. Branching belongs inside a use case or in a sub-chain selected by the
caller. This keeps the framework small and forces business-shaped decisions into business code.

Kernel algorithms (`src/kernel/algorithms/`) are pure helpers consumed by chains and adapters: dependency
reorder, mutex queue, rate-limit coordinator, signal micro-batcher.

The `ChainRunner` (`src/kernel/runtime/chain-runner.ts`) wraps one `Element.execute()` call with a status machine
(`idle | running | completed | failed | aborted`), an event stream, and a live trace.

## Multi-chain runtime

The runtime supports **N chains executing concurrently**. Each chain runs as an independent session with its own
state — context, trace, signal subscription, log tail, abort handle.

```
kernel/runtime/chain-runner.ts             ← one runner = one chain execution
application/runtime/session-manager-port.ts ← interface
application/runtime/session-manager.ts      ← in-memory implementation
application/runtime/live-config-reader.ts   ← FileLiveConfigReader — re-reads Config fresh per call
```

`SessionManager` owns N runners, mirrors their status into immutable `SessionDescriptor` snapshots, and emits a
registry-level event stream (`added | removed | active-changed`).

Public surface: `start({ element, initialCtx, label }) → SessionId`, `list()`, `get(id)`, `foreground(id)`,
`background()`, `kill(id)`, `dispose()`.

`FileLiveConfigReader` is the live-config seam (REQ-12): use cases that need the current config — most importantly
the per-task evaluator loop — call `reader.current()` every settlement so settings-panel edits land on the next task
without restart. Falls back to `CONFIG_DEFAULTS` on transient store errors.

`ChainRunner.subscribe` emits `step` events progressively as each leaf settles (see `kernel/runtime/chain-runner.ts`),
not as a single end-of-run replay. The kernel passes an `onTrace` callback through `Sequential` / `Parallel` /
`Retry` / `OnError` so the dashboard can render the trace as it happens. Late subscribers attached after the runner
reaches a terminal state still receive a synthetic replay (`step*` then the matching terminal event).

UX:

- **TUI** — Tab cycles sessions, Shift+Tab cycles backwards, `Ctrl+1..9` direct-jump. Dedicated Sessions view
  (`application/tui/views/sessions-view.tsx`) lists every runner with status + age. Foregrounding swaps the live
  execute view to that runner's stream. Background runners keep emitting; logs accumulate so re-attaching shows the
  full trace.
- **CLI** — `ralphctl sessions list / attach <id> / detach <id> / kill <id>`. Attach in non-TTY streams JSONL events
  to stdout until the runner finishes or Ctrl+C.

The kernel `Parallel` element (intra-chain fan-out) is unrelated to multi-chain concurrency — they compose freely.

## Use cases (`src/business/usecases/`)

Every business operation is a class with constructor-injected port dependencies and a single `execute()` method
returning `Result<T, DomainError>`. Use cases are unaware of the chain framework. A `Leaf` is the seam: it adapts
`UseCase.execute(input)` into `Element.execute(ctx)`.

Layout (one folder per workflow group):

```
business/usecases/
├── evaluate/        evaluate-task, plateau-detection
├── execute/         branch-preflight, execute-single-task, post-task-check, recover-dirty-tree
├── feedback/        apply-feedback
├── ideate/          ideate-and-plan
├── plan/            plan-sprint-tasks, task-list-parser
├── project/         create / list / show / remove project; add / remove / update repository
├── refine/          refine-single-ticket
├── sprint/          create / list / show / remove / activate / close
├── task/            add / list / show / remove / edit-status
└── ticket/          add / edit / remove / approve
```

`ExecuteSingleTaskUseCase` is the per-task body; per-task orchestration lives in `application/chains/execute/per-task-flow.ts`.
There is no monolithic `ExecuteTasksUseCase` — fan-out is the chain's job.

## Ports

### Service ports (`src/business/ports/`)

| Port                | Responsibility                                                         | Implementation                                                           |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `AiSessionPort`     | Spawning AI CLI sessions (Claude / Copilot)                            | `ProviderAiSessionAdapter` (`integration/ai/session/`)                   |
| `PromptBuilderPort` | Compile `.md` prompt templates with context                            | `TextPromptBuilderAdapter` (`integration/ai/prompts/`)                   |
| `ExternalPort`      | `git`, `gh`/`glab` integration, branch verification, lifecycle hooks   | `DefaultExternalAdapter` (`integration/external/`)                       |
| `SignalParserPort`  | Extract `HarnessSignal[]` from raw AI stdout                           | `SignalParser` (`integration/signals/parser.ts`)                         |
| `SignalHandlerPort` | Durable writes for parsed signals (progress, evaluation, …)            | `FileSystemSignalHandler` (`integration/signals/file-system-handler.ts`) |
| `SignalBusPort`     | Live observer stream (dashboard subscribes)                            | `InMemorySignalBus` (`integration/signals/bus.ts`)                       |
| `LoggerPort`        | Structured logging + UI output                                         | `PlainTextSink`, `JsonLogger`, `InkSink` (`integration/logging/`)        |
| `PromptPort`        | Interactive prompts (select/confirm/input/checkbox/editor/fileBrowser) | `InkPromptAdapter` (`integration/ui/prompts/`) — single implementation   |

### Repository interfaces (`src/domain/repositories/`)

Per-aggregate repositories live in `domain/repositories/` as interfaces. Implementations live in
`integration/persistence/`.

| Interface           | Implementation                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `ProjectRepository` | `FileProjectRepository` (`integration/persistence/file-project-repository.ts`) |
| `SprintRepository`  | `FileSprintRepository` (`integration/persistence/file-sprint-repository.ts`)   |
| `TaskRepository`    | `FileTaskRepository` (`integration/persistence/file-task-repository.ts`)       |

The monolithic `PersistencePort` from the legacy architecture is gone. Each aggregate has its own repository.

## Composition root

```
application/bootstrap/
├── shared-deps.ts         ← createSharedDeps(overrides?) — constructs every adapter
├── get-shared-deps.ts     ← getSharedDeps() / setSharedDeps() / getPrompt()
├── fan-out-logger.ts      ← FanOutLogger wrapping console + JsonlSink
└── jsonl-sink.ts          ← LoggerPort adapter writing to <logsDir>/<sessionId>.jsonl
```

`createSharedDeps()` constructs every concrete adapter the runtime needs and wires them together. Tests build a focused
subset by passing `overrides` for just the ports under test. Chain factories accept a narrower `ChainSharedDeps` view
(`src/application/chains/chain-deps.ts`) so reading a factory's signature tells you exactly which ports the
workflow depends on.

The CLI entrypoint (`application/cli/entrypoint.ts`) builds a Commander program from the `SharedDeps` graph and
dispatches to the matching command file. The Ink mount path (`application/tui/runtime/mount.tsx`) detects TTY, swaps
`SharedDeps.{logger,signalBus,prompt}` to Ink variants via `setSharedDeps`, enters the alt-screen buffer, renders
`<App />`, and awaits `waitUntilExit()`.

## Chain definitions (`src/application/chains/`)

```
chains/
├── chain-deps.ts                 ← ChainSharedDeps (narrowed view of SharedDeps)
├── leaves/                       ← shared leaves: load-sprint, load-tasks, save-sprint,
│                                   save-tasks, link-skills, unlink-skills, reorder-tasks
├── refine/refine-flow.ts         ← createRefineFlow(deps, opts): Element<RefineCtx>
├── plan/plan-flow.ts             ← load-sprint → assert-draft → assert-all-tickets-approved →
│                                   persist-repo-selection → load-existing-tasks → confirm-replan →
│                                   plan-tasks → reorder-tasks → confirm-task-list → save-tasks
├── ideate/ideate-flow.ts
├── execute/
│   ├── execute-flow.ts           ← outer: load-sprint → assert-active → load-tasks →
│   │                               check-scripts-sprint-start → link-skills → execute-tasks
│   │                               (Parallel of per-task chains) → unlink-skills
│   └── per-task-flow.ts          ← per-task: branch-preflight (OnError → mark-blocked) →
│                                   mark-in-progress → wait-for-rate-limit →
│                                   execute-task (Retry on rate-limit) →
│                                   post-task-check → recover-dirty-tree →
│                                   evaluate-task (nested evaluate-and-fix loop, OnError catch-all) →
│                                   mark-done
├── evaluate/evaluate-flow.ts     ← load-sprint → load-task → check-already-evaluated →
│                                   evaluate-task → persist-evaluation
├── feedback/feedback-flow.ts     ← load-sprint → apply-feedback → check-scripts-feedback →
│                                   record-feedback-iteration
├── onboard/onboard-flow.ts       ← load-project → resolve-repo → run-onboard-ai →
│                                   confirm-setup-script → confirm-verify-script →
│                                   confirm-context-file → write-context-file → save-repo-scripts
└── create-pr/create-pr-flow.ts   ← load-sprint → assert-has-branch → derive-pr-content →
                                    create-pull-request → record-pr-url
```

Per-pipeline step traces are the architectural fence. Each `<name>-flow.test.ts` asserts
`trace.map(s => s.stepName)` on happy + failure paths.

| Chain     | Happy-path step trace                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refine    | `load-sprint → assert-draft → link-skills → refine-tickets → unlink-skills`                                                                                                                                                                                                     |
| Plan      | `load-sprint → assert-draft → assert-all-tickets-approved → persist-repo-selection → load-existing-tasks → confirm-replan → plan-tasks → reorder-tasks → confirm-task-list → save-tasks`                                                                                        |
| Ideate    | `load-sprint → assert-draft → run-ideation → reorder-dependencies`                                                                                                                                                                                                              |
| Execute   | `load-sprint → assert-active → load-tasks → check-scripts-sprint-start → link-skills → execute-tasks → unlink-skills` (per-task: `branch-preflight → mark-in-progress → wait-for-rate-limit → execute-task → post-task-check → recover-dirty-tree → evaluate-task → mark-done`) |
| Evaluate  | `load-sprint → load-task → check-already-evaluated → evaluate-task → persist-evaluation`                                                                                                                                                                                        |
| Feedback  | `load-sprint → apply-feedback → check-scripts-feedback → record-feedback-iteration`                                                                                                                                                                                             |
| Onboard   | `load-project → resolve-repo → run-onboard-ai → confirm-setup-script → confirm-verify-script → confirm-context-file → write-context-file → save-repo-scripts`                                                                                                                   |
| Create-PR | `load-sprint → assert-has-branch → derive-pr-content → create-pull-request → record-pr-url`                                                                                                                                                                                     |

CLI commands and TUI views invoke chain factories (`createXxxFlow(deps, opts)`) and launch via
`SessionManager.start({ element, initialCtx, label })` — never `chain.execute()` directly. An ESLint
`no-restricted-imports` fence prevents direct use-case imports from CLI commands and TUI views.

Integration tests under `application/chains/<name>/<name>-flow.test.ts` assert
`trace.map(s => s.stepName)` to lock each chain's step order on happy + failure paths. Step-order regressions break
the build.

## Validation strategy

- **Value objects** (`src/domain/values/`) — branded types with smart constructors that return `Result<T>`.
  Instances are always valid. Examples: `SprintId`, `TaskId`, `TicketId`, `ProjectName`, `Slug`, `AbsolutePath`,
  `IsoTimestamp`. Zod is used inside the smart constructor where a format check helps; otherwise plain runtime checks.
- **Entities** (`src/domain/entities/`) — trust their own invariants. No Zod inside `Sprint`, `Project`, `Task`,
  `Ticket`, `Repository`. Mutators return new instances; classes are structurally immutable. Lifecycle invariants live
  in the entity, not at the use-case layer.
- **Serialization boundary** — Zod schemas in `src/integration/persistence/schemas/` validate JSON when
  reading/writing files. Round-trip type safety; on-disk corruption surfaces as a typed `ValidationError`.
- **External input boundary** — Zod for AI output parsing (`tasks.json`, requirements blobs).

## Result types

`Result<T, E>` and `AsyncResult<T, E>` come from `typescript-result`, but every consumer imports from
`src/domain/result.ts` — the canonical re-export point. Future PRs that swap the underlying library or wrap it
with project-specific helpers can do so by changing this single file.

Use cases return `Result<T, DomainError>`; throws are reserved for programmer errors. Persistence-layer functions may
throw domain errors for bottom-of-the-stack failures — the use-case layer wraps them.

## Storage layout

```
~/.ralphctl/                         ← override with RALPHCTL_ROOT
├── config/
│   ├── config.json                  ← global settings (currentSprint, aiProvider, …)
│   └── projects.json                ← project + repo registry
├── data/
│   ├── sprints/<sprint-id>/
│   │   ├── sprint.json              ← sprint + nested tickets
│   │   ├── tasks.json               ← task list
│   │   ├── progress.md              ← append-only signal log
│   │   ├── requirements.md
│   │   ├── evaluations/<task-id>.md
│   │   ├── ideation/<ticket-id>/
│   │   ├── refinement/<ticket-id>/
│   │   └── planning/
│   └── insights/<sprint-id>.md
├── cache/                           ← transient, safe to delete
│   ├── skills/                      ← synced default skills
│   └── prompts-compiled/            ← optional
├── logs/
│   └── <session-id>.jsonl           ← per-session structured trace (every log entry, signal, error)
└── backups/                         ← auto-snapshot before destructive ops
```

Resolution lives in `src/integration/persistence/storage-paths.ts` (`resolveStoragePaths`,
`ensureLayoutDirs`). The application-side wrapper at `application/runtime/storage-paths-resolver.ts` re-exports for
the composition root.

The `logs/` folder is the high-leverage add. Every session writes a structured JSONL trace via `JsonlSink` so
post-hoc debugging is `tail -f` not guesswork.

`sprint requirements [--output <path>]` and `sprint context [--output <path>]` are markdown **exports**, not state.
They default to the caller's `cwd` (`./<sprintId>-requirements.md` / `./<sprintId>-context.md`) and accept any
absolute or relative path. The exporter does not write inside `~/.ralphctl/` — these are user-owned artefacts.

## Data Models

Entity shapes (canonical types in `src/domain/entities/<name>.ts`; class-based, immutable, with
`Result`-returning smart constructors):

### Project & Repository

```typescript
class Project {
  readonly name: ProjectName; // Branded slug VO
  readonly displayName: string;
  readonly description: string | undefined;
  readonly repositories: readonly Repository[]; // ≥1, unique by path
}

class Repository {
  readonly name: string; // defaults to basename(path)
  readonly path: AbsolutePath; // primary identity
  readonly checkScript: string | undefined; // post-task verification gate
  readonly checkTimeout: number | undefined; // overrides RALPHCTL_SETUP_TIMEOUT_MS
  readonly setupScript: string | undefined; // one-shot prepare command (e.g. `pnpm install`)
  readonly onboardedAt: IsoTimestamp | null; // set by createOnboardFlow on a successful run
}
```

### Sprint

```typescript
class Sprint {
  readonly id: SprintId; // YYYYMMDD-HHmmss-<slug>
  readonly name: string;
  readonly status: 'draft' | 'active' | 'closed';
  readonly createdAt: IsoTimestamp;
  readonly activatedAt: IsoTimestamp | null;
  readonly closedAt: IsoTimestamp | null;
  readonly tickets: readonly Ticket[];
  readonly checkRanAt: ReadonlyMap<AbsolutePath, IsoTimestamp>; // cleared on close
  readonly branch: string | null; // sprint branch, null = no branch management
  readonly pullRequestUrl: string | null; // recorded by createCreatePrFlow
  readonly projectName: ProjectName; // set at sprint create time; one sprint = one project
  readonly affectedRepositories: readonly AbsolutePath[]; // set by persist-repo-selection in planFlow
}

// Mutators: `Sprint.rename(name)`, `Sprint.clearBranch()`,
// `Sprint.recordPullRequestUrl(url)`, `Sprint.setAffectedRepositories(paths)`.
// Repository: `markOnboarded(now)`, `clearOnboarded()`, `withSetupScript(script)`.
// Task: `update(input)`, `markBlocked(reason)`, `unblock()`.
```

### Ticket (nested in Sprint)

```typescript
class Ticket {
  readonly id: TicketId;
  readonly title: string;
  readonly description: string | undefined;
  readonly link: string | undefined;
  readonly requirementStatus: 'pending' | 'approved';
  readonly requirements: string | undefined; // set by sprint refine
}
```

### Task

```typescript
class Task {
  readonly id: TaskId;
  readonly name: string;
  readonly description: string | undefined;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly string[];
  readonly status: 'todo' | 'in_progress' | 'done' | 'blocked';
  readonly order: number; // 1-indexed
  readonly ticketId: TicketId | undefined;
  readonly blockedBy: readonly TaskId[];
  readonly projectPath: AbsolutePath;
  readonly verified: boolean;
  readonly verificationOutput: string | undefined;
  readonly evaluated: boolean;
  readonly evaluationOutput: string | undefined; // truncated to 2000 chars
  readonly evaluationStatus: 'passed' | 'failed' | 'malformed' | undefined;
  readonly evaluationFile: string | undefined; // <sprintDir>/evaluations/<taskId>.md
  readonly extraDimensions: readonly string[] | undefined;
  readonly blockedReason: string | undefined; // set by markBlocked, cleared by unblock
}
```

### Config (application-level, not domain)

```typescript
interface Config {
  currentSprint: string | null;
  aiProvider: 'claude' | 'copilot' | null;
  editor: string | null;
  evaluationIterations?: number; // 0 = disabled, default fallback: 1
}
```

## Harness Signals

Fixed discriminated union in `src/domain/signals/harness-signal.ts`. Adding a variant requires a code change;
every `switch` on `HarnessSignal['type']` is exhaustiveness-checked by the compiler via
`const _exhaustive: never = signal`.

| Signal                       | Parsed from                                                        | Durable handler                                                                              |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `ProgressSignal`             | `<progress><summary>…</summary>…</progress>`                       | Append to `progress.md`                                                                      |
| `EvaluationSignal`           | `<evaluation-passed>` / `<evaluation-failed>…</evaluation-failed>` | Sidecar (`evaluations/<task-id>.md`) + `tasks.json` preview                                  |
| `TaskCompleteSignal`         | `<task-complete>`                                                  | None (per-task chain owns task lifecycle)                                                    |
| `TaskVerifiedSignal`         | `<task-verified>output</task-verified>`                            | None (use case sets `verified` on the task entity)                                           |
| `TaskBlockedSignal`          | `<task-blocked>reason</task-blocked>`                              | Record blocker in `progress.md`                                                              |
| `NoteSignal`                 | `<note>text</note>`                                                | Append to `progress.md`                                                                      |
| `CheckScriptDiscoverySignal` | `<check-script>command</check-script>`                             | None — consumed inline by setup flow (`project add` / `project repo add`)                    |
| `AgentsMdProposalSignal`     | `<agents-md>…</agents-md>`                                         | None — consumed inline by `project onboard`; harness writes the provider-native file         |
| `SetupScriptSignal`          | `<setup-script>command</setup-script>`                             | None — consumed inline by `project onboard`; persisted on `Repository.setupScript`           |
| `VerifyScriptSignal`         | `<verify-script>command</verify-script>`                           | None — consumed inline by `project onboard`; persisted on `Repository.checkScript`           |
| `SkillSuggestionsSignal`     | `<skill-suggestions>name1, name2, …</skill-suggestions>`           | None — consumed inline by `project onboard`; user-accepted subset linked via the skills port |

Plus synthetic bus events emitted by the per-task chain (not parsed from AI output): `rate-limit-paused`,
`rate-limit-resumed`, `task-started`, `task-finished`. The `InMemorySignalBus` micro-batches emissions at ~16ms
(one animation frame) to prevent render storms.

Live signal forwarding: `ExecuteSingleTaskUseCase` forwards every parsed `HarnessSignal` onto `SignalBusPort` as
`{ type: 'signal', signal, sprintId, taskId }` so the live execute view's "Recent events" panel renders
`<progress>`, `<note>`, `<task-verified>`, etc. in real time. `ApplyFeedbackUseCase` does the same (without `taskId`).
Rate-limit pause / resume reach the bus from two sources, both wired in the composition root: the AI session
adapter's per-spawn retry loop emits when the adapter sleeps for a single rate-limit recovery; the kernel
`RateLimitCoordinator` emits when its global state changes. The dashboard's `RateLimitBanner` consumes either.

The kernel `RateLimitCoordinator` (`src/kernel/algorithms/rate-limit-coordinator.ts`) is the global pause
primitive. The per-task chain's `wait-for-rate-limit` leaf awaits `coordinator.waitUntilResumed()` before launching
the AI session, so when one task hits a 429 and `ExecuteSingleTaskUseCase` calls `coordinator.pause(reason)`,
every other in-flight per-task chain throttles in lock-step instead of spawning fresh AI sessions and
immediately rate-limiting again. The chain's `Retry(maxAttempts: 2, retryOn: 'rate-limited')` continues to handle
the in-task retry independently.

## Error Classes

All domain errors extend `DomainError` (`src/domain/errors/domain-error.ts`) and carry a machine-readable `code`
plus optional `cause`.

| Class               | Group       | Cause                                                                  |
| ------------------- | ----------- | ---------------------------------------------------------------------- |
| `NotFoundError`     | not-found   | Aggregate (project / sprint / ticket / task) not found by id           |
| `ConflictError`     | lifecycle   | Uniqueness or cardinality violation (e.g. duplicate slug, repo path)   |
| `InvalidStateError` | lifecycle   | Operation invalid for the entity's current status                      |
| `ValidationError`   | values      | Smart-constructor or schema validation failed (carries `field`/`path`) |
| `ParseError`        | storage     | JSON / output parser rejection                                         |
| `StorageError`      | storage     | Read/write failure in the persistence layer                            |
| `RateLimitError`    | ai-provider | AI process rate-limited (wraps spawn outcome)                          |

Plus the kernel's structural error type (`KernelError` in `src/kernel/chain/element.ts`) which carries `code` /
`message` / `cause` — every `DomainError` satisfies this shape so chains can surface domain errors transparently in
their trace.

## Exit Codes

`src/application/cli/exit-codes.ts`:

| Code | Constant           | Meaning                       |
| ---- | ------------------ | ----------------------------- |
| 0    | `EXIT_SUCCESS`     | All operations completed      |
| 1    | `EXIT_ERROR`       | Validation or execution error |
| 130  | `EXIT_INTERRUPTED` | SIGINT received               |

## Terminal UI Layer (`src/application/tui/`)

Stock Ink + `@inkjs/ui`. Mounted only for bare `ralphctl`, `ralphctl interactive`, and `ralphctl sprint start`. All
other subcommands use `PlainTextSink` + Commander. Non-TTY / `CI=1` / `RALPHCTL_JSON=1` / `RALPHCTL_NO_TUI=1`
short-circuit to the plain-text path.

The mount path enters the **alt-screen buffer** (`CSI ? 1049 h`) and hides the cursor so ralphctl takes over the
terminal the way vim/htop/less does. Restoration is guaranteed via explicit `exitAltScreen()` after `waitUntilExit()`
plus `process.on('exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'uncaughtException')` safety nets.

```
application/tui/
├── runtime/
│   ├── mount.tsx         ← mountInkApp() — TTY gate, SharedDeps swap, alt-screen, render+waitUntilExit
│   ├── screen.ts         ← enterAltScreen() / exitAltScreen() + signal-safe restore
│   ├── event-bus.ts      ← Singleton log event bus (InkSink publisher, <LogTail /> subscriber)
│   └── hooks.ts          ← useLoggerEvents, useSignalEvents, useSessionEvents
├── components/           ← ViewShell, SectionStamp, ResultCard, FieldList, KeyboardHints,
│                           StatusBar, ListView, RateLimitBanner, Spinner, StatusChip, useWorkflow
└── views/                ← Top-level screens — each is a router destination
    ├── app.tsx           ← Root — seeds the router stack, mounts <PromptHost /> as sibling
    ├── router-context.ts ← ViewId union + RouterApi React context
    ├── view-router.tsx   ← Navigation stack
    ├── use-global-keys.ts ← Esc/h/s/d/Tab/Ctrl+1..9/q owned by the router
    ├── view-hints-context.tsx
    ├── home-view.tsx     ← Idle landing
    ├── dashboard-view.tsx
    ├── execute-view.tsx  ← Live sprint-execution dashboard (subscribes to SignalBus + logEventBus)
    ├── sessions-view.tsx ← Multi-chain switcher
    ├── settings-view.tsx ← Schema-driven rows
    ├── browse/           ← list + show views (sprint, ticket, task, project)
    └── crud/             ← add / edit / remove views
```

Prompt components live at `src/integration/ui/prompts/` so plain-text CLI commands that need a prompt can
auto-mount a minimal `<PromptHost />` without pulling in the dashboard.

Cross-cutting TUI features (testable criteria in `REQUIREMENTS.md`):

- **Persistent banner** — `<Banner />` renders on every view via `<ViewShell />`. The quote stabilises at module
  load (`STABLE_QUOTE` in `components/banner.tsx`) so navigation doesn't jitter.
- **Help modal** — `?` opens `<HelpOverlay />`. The router renders ONLY the overlay when `isHelpOpen`; view tree,
  prompts, hints, and the status bar are all suspended. Esc / `?` closes.
- **Centralised keyboard map** — `application/tui/keyboard-map.ts` is the single source of truth. The help overlay
  generates its rows from the same table; view-local hints declare their actions, not key bindings.
- **Pipeline map + tiered submenus** — Home renders `<PipelineMap />` (Refine / Plan / Execute / Close 4-row spine
  - bright "Next step" quick-action). `b` opens the browse submenu → drill-ins for Sprint / Ticket / Task / Project,
    driven by a typed `MenuAction` discriminated union (no string-encoded routing).
- **Prompt transcript** — resolved prompts render dim above the live prompt as a transcript so the user sees the
  values they've already entered. History clears when the queue idles past `SEQUENCE_IDLE_MS = 100ms`. Per-kind
  renderers in `prompt-transcript.tsx`.
- **Schema-driven settings** — rows iterate `CONFIG_ROWS` (`application/config/config-schema-rows.ts`); the prompt
  kind (`select` / `confirm` / `input`) is determined by value type. Edits save immediately via
  `ConfigStorePort.save()`.
- **Doctor view** — `<DoctorView />` runs `runDoctor()` on mount; renders per-check status rows + an aggregate
  `ResultCard`. `!` hotkey opens it. Checks live in `application/doctor/checks/`, including `onboarding-status.ts`.
- **Retry-loop forms** — sprint-create / project-add / ticket-add / task-add / sprint-edit / project-edit views
  retry on validation errors instead of dumping back to home.

## Chain framework

See [KERNEL-DESIGN.md](./KERNEL-DESIGN.md) for the full contract: `Element` interface, six concepts, semantics of
each primitive, trace contract, and worked examples for `refineFlow` and the per-task `executeFlow`.

## Future Work

- **Per-repo feedback-loop check fan-out.** `feedback-flow.ts` records that checks should run after applying feedback
  but does not yet fan out per-repo. Real fan-out needs a `forEachItem`-shaped primitive in the kernel.
- **Cross-sprint browse views.** The TUI browse subtree (`tui/views/browse/`) ships per-sprint listing. Cross-sprint
  navigation is a follow-up.
- **`forEachItem` / `Loop` kernel primitive.** A few latent uses share the same shape — "fan out an inner chain over
  N items with bounded concurrency, retry policy, and shared rate-limit coordinator". Build it once the second
  consumer materialises rather than speculating.
- **Conditional element if needed.** Today, branching belongs inside a use case or in a sub-chain selected by the
  caller. If a recurring pattern emerges where neither option fits cleanly, a `Conditional` primitive can be added —
  but only with a documented justification.

(Resolved follow-ups: live evaluation-config read landed via `LiveConfigReader`; the multi-iteration evaluator loop
landed via `EvaluateAndFixLoopUseCase` inside the per-task chain; the progressive chain trace ships via
`ChainRunner.subscribe`'s `step` events.)
