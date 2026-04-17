# RalphCTL - Architecture

Data models, file storage, and reference tables. For constraints, see the root CLAUDE.md. For acceptance criteria,
see [REQUIREMENTS.md](./REQUIREMENTS.md).

## Clean Architecture Layers

Dependencies always point inward. Inner layers are never allowed to import from outer layers. No barrel `index.ts`
files — every import points to its source module directly.

```
┌─────────────────────────────────────────────────────────────────┐
│  Application (outermost — composition root)                     │
│  src/application/{entrypoint,shared,bootstrap,factories}.ts     │
├─────────────────────────────────────────────────────────────────┤
│  Integration (frameworks & drivers)                             │
│  src/integration/{persistence,filesystem,ai,external,signals,   │
│    logging,prompts,ui,cli,config,user-interaction,utils}        │
│  Ink TUI, adapters, CLI commands, file-backed persistence       │
├─────────────────────────────────────────────────────────────────┤
│  Business (use cases + service ports + pipelines)               │
│  src/business/{usecases,ports,pipeline,pipelines}               │
│  ExecuteTasksUseCase, RefineTicket..., Plan..., Evaluate...     │
├─────────────────────────────────────────────────────────────────┤
│  Domain (models + repository interfaces, pure, zero deps)       │
│  src/domain/{models,errors,signals,context,types,               │
│    config-schema,repositories/}                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Repository interfaces (`src/domain/repositories/`)

Data-access contracts that business logic depends on. Implementations live in `src/integration/`.

| Interface         | Responsibility                                       | Implementation                                            |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `PersistencePort` | Sprint/task/ticket/config/project storage            | `FilePersistenceAdapter` (`src/integration/persistence/`) |
| `FilesystemPort`  | Directory/file read-write at the filesystem boundary | `NodeFilesystemAdapter` (`src/integration/filesystem/`)   |

### Service ports (`src/business/ports/`)

Non-repository ports — external services, UI, and parsers.

| Port                  | Responsibility                                                         | Implementations                                        |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `AiSessionPort`       | Spawning AI CLI sessions (Claude / Copilot)                            | `ProviderAiSessionAdapter` (`src/integration/ai/`)     |
| `PromptBuilderPort`   | Compile `.md` prompt templates with context                            | `TextPromptBuilderAdapter` (`src/integration/ai/`)     |
| `OutputParserPort`    | Parse structured outputs (tasks.json, requirements) from AI            | `DefaultOutputParserAdapter` (`src/integration/ai/`)   |
| `ExternalPort`        | `git`, `gh`/`glab` integration, branch verification                    | `DefaultExternalAdapter` (`src/integration/external/`) |
| `SignalParserPort`    | Extract `HarnessSignal[]` from raw AI stdout                           | `SignalParser` (`src/integration/signals/parser.ts`)   |
| `SignalHandlerPort`   | Durable writes for parsed signals (progress, evaluation, …)            | `FileSystemSignalHandler` (`src/integration/signals/`) |
| `SignalBusPort`       | Live observer stream (dashboard subscribes)                            | `InMemorySignalBus`, `NoopSignalBus`                   |
| `LoggerPort`          | Structured logging + UI output (success, warning, spinner, …)          | `PlainTextSink`, `JsonLogger`, `InkSink`               |
| `PromptPort`          | Interactive prompts (select/confirm/input/checkbox/editor/fileBrowser) | `InkPromptAdapter` (single implementation)             |
| `UserInteractionPort` | Domain-level interactive flows (selectPaths, getFeedback, …)           | `InteractiveUserAdapter`, `AutoUserAdapter`            |

### Use cases (`src/business/usecases/`)

- `RefineTicketRequirementsUseCase` — per-ticket HITL clarification
- `PlanSprintTasksUseCase` / `IdeateAndPlanUseCase` — task generation
- `ExecuteTasksUseCase` — sequential + parallel executor, feedback loop, generator-evaluator
- `EvaluateTaskUseCase` — autonomous post-task code review

All return `Result<T, DomainError>` from `typescript-result`. Throw-free at use-case boundaries.

### Pipelines (`src/business/pipelines/`)

Steps (composable, pre/post hooks, typed context) — see `refine-plan.ts` for the reference pipeline.

### Composition root

- `src/application/entrypoint.ts` — process entry. Registers Commander commands, routes bare / `interactive` /
  `sprint start` invocations through `mountInkApp`, falls through to Commander otherwise.
- `createSharedDeps(overrides?)` (`src/application/shared.ts`) — constructs every port's default implementation;
  accepts overrides so the Ink mount path can swap in `InkSink` + `InMemorySignalBus`.
- `getSharedDeps()` / `setSharedDeps(deps)` / `getPrompt()` (`src/application/bootstrap.ts`) — cached accessor,
  swap hook, and a convenience helper commands use to reach the `PromptPort`.
- Factory functions (`src/application/factories.ts`) construct each use case with the right adapter graph per call.

## Data Models

All types defined in `src/domain/models.ts` (Zod) with JSON schema mirrors in `/schemas/`.

### Project

```typescript
interface Project {
  name: string; // Slug ID (lowercase alphanumeric + hyphens)
  displayName: string;
  repositories: Repository[]; // At least one required
  description?: string;
}

interface Repository {
  name: string; // Auto-derived from basename(path)
  path: string; // Absolute path (validated as existing directory)
  checkScript?: string; // e.g., "pnpm install && pnpm typecheck && pnpm lint && pnpm test"
  checkTimeout?: number; // Per-repo timeout in ms (overrides RALPHCTL_SETUP_TIMEOUT_MS)
}
```

### Sprint

```typescript
interface Sprint {
  id: string; // Format: YYYYMMDD-HHmmss-<slug>
  name: string;
  status: 'draft' | 'active' | 'closed';
  createdAt: string; // ISO8601
  activatedAt: string | null;
  closedAt: string | null;
  tickets: Ticket[];
  checkRanAt: Record<string, string>; // projectPath → ISO8601 (cleared on close)
  branch: string | null; // Sprint branch name (null = no branch management)
}
```

### Ticket

```typescript
interface Ticket {
  id: string; // UUID8 (auto-generated)
  title: string;
  description?: string;
  link?: string; // Validated as URL
  projectName: string; // References Project.name
  affectedRepositories?: string[]; // Absolute paths, set by sprint plan
  requirementStatus: 'pending' | 'approved';
  requirements?: string; // Set by sprint refine
}
```

### Task

```typescript
interface Task {
  id: string; // UUID8
  name: string;
  description?: string;
  steps: string[];
  verificationCriteria: string[]; // Grading contract surfaced to the evaluator
  status: 'todo' | 'in_progress' | 'done';
  order: number; // 1-indexed
  ticketId?: string;
  blockedBy: string[]; // Dependency task IDs
  projectPath: string; // Execution directory
  verified: boolean; // Default: false
  verificationOutput?: string;
  evaluated: boolean; // Default: false — whether evaluator ran
  evaluationOutput?: string; // Preview (truncated to 2000 chars); full critique lives in evaluationFile
  evaluationStatus?: 'passed' | 'failed' | 'malformed'; // 'malformed' = no parseable signal (distinct from failure)
  evaluationFile?: string; // Sidecar path: <sprintDir>/evaluations/<taskId>.md
}
```

### Config

```typescript
interface Config {
  currentSprint: string | null;
  aiProvider: 'claude' | 'copilot' | null;
  editor: string | null;
  evaluationIterations?: number; // 0 = disabled, default fallback: 1
}
```

## Harness Signals

Fixed discriminated union in `src/domain/signals.ts`. Adding a variant requires a code change; every switch on
`HarnessSignal['type']` is exhaustiveness-checked by the compiler via `const _exhaustive: never`.

| Signal               | Parsed from                                                        | Durable handler                     | Bus event |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------- | --------- |
| `ProgressSignal`     | `<progress><summary>…</summary>…</progress>`                       | Append to `progress.md`             | `signal`  |
| `EvaluationSignal`   | `<evaluation-passed>` / `<evaluation-failed>…</evaluation-failed>` | Sidecar + `tasks.json`              | `signal`  |
| `TaskCompleteSignal` | `<task-complete>`                                                  | None (use case owns task lifecycle) | `signal`  |
| `TaskVerifiedSignal` | `<task-verified>output</task-verified>`                            | None (use case sets `verified`)     | `signal`  |
| `TaskBlockedSignal`  | `<task-blocked>reason</task-blocked>`                              | Record blocker in `progress.md`     | `signal`  |
| `NoteSignal`         | `<note>text</note>`                                                | Append to `progress.md`             | `signal`  |

Plus synthetic bus events emitted by the executor (not parsed from AI output):
`rate-limit-paused`, `rate-limit-resumed`, `task-started`, `task-finished`.

## Terminal UI Layer (`src/integration/ui/tui/`)

Stock Ink + `@inkjs/ui`. Mounted only for bare `ralphctl`, `ralphctl interactive`, and `ralphctl sprint start` — all
other subcommands use `PlainTextSink` + Commander. Non-TTY / `CI=1` / `RALPHCTL_JSON=1` / `RALPHCTL_NO_TUI=1` short-circuit
to the plain-text path.

The mount path enters the **alt-screen buffer** (`CSI ? 1049 h`) and hides the cursor so ralphctl takes over the
terminal the way vim/htop/less does. Restoration is guaranteed via explicit `exitAltScreen()` after `waitUntilExit()`
plus `process.on('exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'uncaughtException')` safety nets in
`src/integration/ui/tui/runtime/screen.ts`.

Prompt components live _outside_ the TUI tree at `src/integration/prompts/` so plain-text CLI commands that need a
prompt can auto-mount a minimal `<PromptHost />` without pulling in the dashboard.

```
src/integration/ui/tui/
├── runtime/
│   ├── mount.tsx        # mountInkApp() — TTY gate, SharedDeps swap, enter/exit alt-screen, render+waitUntilExit
│   ├── screen.ts        # enterAltScreen()/exitAltScreen() + signal-safe restore
│   ├── event-bus.ts     # Singleton log event bus (InkSink publisher, <LogTail /> subscriber)
│   └── hooks.ts         # useLoggerEvents, useSignalEvents, useLiveConfig
├── components/          # Leaf UI: Banner, DashboardHeader, TaskGrid, TaskRow, LogTail, StatusBar,
│                        # SprintSummary, RateLimitBanner, ActionMenu
├── views/               # Top-level screens
│   ├── app.tsx          # Root — dispatches on initialView, mounts <PromptHost /> as sibling
│   ├── repl-view.tsx    # Idle REPL (banner + header + action menu + submenu)
│   ├── execute-view.tsx # Live sprint-execution dashboard (subscribes to SignalBus + logEventBus)
│   ├── settings-panel.tsx  # Overlay; iterates getAllSchemaEntries(); type-aware prompt dispatch
│   ├── menu-builder.ts  # Pure buildMainMenu/buildSubMenu
│   ├── dashboard-data.ts  # Dashboard data shape + next-action suggestion
│   └── command-map.ts   # ReplView action → command function dispatch
└── theme/tokens.ts      # Colorette → Ink <Text color=…> prop names

src/integration/prompts/
├── prompt-adapter.ts    # InkPromptAdapter — the single PromptPort implementation
├── prompt-queue.ts      # FIFO queue of PendingPrompt
├── prompt-host.tsx      # Renders the head prompt using the matching component
├── auto-mount.tsx       # ensurePromptHost() — spins up a minimal Ink tree when no dashboard is active
├── hooks.ts             # useCurrentPrompt — subscription for PromptHost
├── select/confirm/input/checkbox-prompt.tsx
├── editor-prompt.tsx    # Claude-style multi-line inline editor (no external editor spawn)
└── file-browser-prompt.tsx
```

### Rendering & prompt flow

1. `mountInkApp({ initialView, sprintId?, executionOptions? })` detects TTY, enters alt-screen, swaps
   `SharedDeps.{logger,signalBus,prompt}` to Ink variants via `setSharedDeps`, and calls `registerExternalHost()` so
   the prompt layer knows a host is live.
2. React renders `<App />` which dispatches to `<ReplView />` or `<ExecuteView />` and always mounts `<PromptHost />`
   as a sibling.
3. Any code path (command, use case, AI runner) calling `getPrompt().confirm(...)` goes to `InkPromptAdapter`. The
   adapter calls `ensurePromptHost()` before enqueueing:
   - Dashboard mounted → no-op (external host handles it).
   - Plain-text CLI command → auto-mount a minimal Ink tree containing only `<PromptHost />`; unmount when the queue
     drains.
   - Non-TTY / CI → throw `PromptCancelledError` with a "pass the value as a flag" hint.
4. `<PromptHost />` subscribes via `useCurrentPrompt()`, renders the head entry using the matching prompt component,
   and resolves or rejects the promise when the user acts.
5. `<ExecuteView />` subscribes to `SignalBusPort` + `logEventBus` via `useSignalEvents` / `useLoggerEvents`, reduces
   events into a `RunState`, and re-renders the task grid + log tail on each micro-batched flush (~16 ms).
6. Ctrl+C → rejects the current prompt with `PromptCancelledError`.

### Live config

`ExecuteTasksUseCase.getEvaluationConfig()` reads `PersistencePort.getConfig()` fresh on each task settlement. The
settings panel saves directly via `PersistencePort.saveConfig()`, so mid-execution edits apply to the next task with
no restart (REQ-12).

## File Storage

```
~/.ralphctl/                          # Default (override with RALPHCTL_ROOT)
├── config.json
├── projects.json
├── insights/                         # sprint insights --export target
│   └── <sprint-id>.md
└── sprints/
    └── <sprint-id>/
        ├── sprint.json               # Sprint + tickets
        ├── tasks.json
        ├── progress.md               # Append-only log
        ├── requirements.md           # Exported via `sprint requirements`
        ├── evaluations/              # Full untruncated evaluator critiques (one file per task)
        │   └── <task-id>.md
        ├── ideation/<ticket-id>/
        │   ├── ideate-context.md
        │   └── output.json
        ├── refinement/<ticket-id>/
        │   ├── refine-context.md
        │   └── requirements.json
        └── planning/
            ├── planning-context.md
            └── tasks.json            # Generated tasks (before import)
```

## Error Classes

All domain errors extend `DomainError` (from `src/domain/errors.ts`) and carry a machine-readable `code` plus optional `cause`.

| Class                  | Group       | Cause                                                                  |
| ---------------------- | ----------- | ---------------------------------------------------------------------- |
| `ProjectNotFoundError` | not-found   | Invalid project name                                                   |
| `ProjectExistsError`   | lifecycle   | Project name already exists                                            |
| `SprintNotFoundError`  | not-found   | Invalid sprint ID                                                      |
| `SprintStatusError`    | lifecycle   | Invalid status for operation                                           |
| `NoCurrentSprintError` | lifecycle   | No current sprint set                                                  |
| `TicketNotFoundError`  | not-found   | Invalid ticket ID                                                      |
| `TaskNotFoundError`    | not-found   | Invalid task ID                                                        |
| `TaskStatusError`      | lifecycle   | Invalid task status operation                                          |
| `DependencyCycleError` | task        | Cycle detected in task `blockedBy` graph                               |
| `NotFoundError`        | not-found   | Generic not-found (repositories, config keys, etc.)                    |
| `ValidationError`      | storage     | Zod validation failed (carries `path`)                                 |
| `ParseError`           | storage     | JSON / output parser rejection                                         |
| `StorageError`         | storage     | Read/write failure in the persistence layer                            |
| `IOError`              | storage     | Low-level filesystem error                                             |
| `LockError`            | storage     | File-lock contention or stale lock (carries `lockPath`)                |
| `ProviderError`        | ai-provider | Provider misconfiguration (missing binary, bad settings)               |
| `SpawnError`           | ai-provider | AI process spawn failure (carries `stderr`, `exitCode`, `rateLimited`) |
| `IssueFetchError`      | external    | Failed to fetch an external issue (GitHub, JIRA)                       |

## Exit Codes

| Code | Constant           | Meaning                       |
| ---- | ------------------ | ----------------------------- |
| 0    | `EXIT_SUCCESS`     | All operations completed      |
| 1    | `EXIT_ERROR`       | Validation or execution error |
| 2    | `EXIT_NO_TASKS`    | No tasks available            |
| 3    | `EXIT_ALL_BLOCKED` | All remaining tasks blocked   |
| 130  | `EXIT_INTERRUPTED` | SIGINT received               |
