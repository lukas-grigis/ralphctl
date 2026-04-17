# RalphCTL - Acceptance Criteria

Testable acceptance criteria for all features. For constraints, see the root CLAUDE.md. For data models,
see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Clean Architecture & Composable Pipelines

- [x] Dependencies point inward only: domain < business < integration < application. Inner layers never import outer
- [x] Use cases depend on ports (interfaces in `src/business/ports/` and `src/domain/repositories/`), never on concrete adapter classes
- [x] Every user-triggered workflow (refine, plan, ideate, evaluate, execute) is a composable pipeline in `src/business/pipelines/`
- [x] Pipelines compose named steps via `pipeline(name, steps[])` from `src/business/pipeline/helpers.ts`
- [x] Shared steps in `src/business/pipelines/steps/` are reused across pipelines (load-sprint, assert-sprint-status, run-check-scripts, branch-preflight, etc.)
- [x] Pipeline failures stop execution and propagate with the failing step name via `StepError` (e.g., `Step 'assert-draft' failed: ...`)
- [x] Each step supports `pre` and `post` hooks as typed async functions registered in the step definition
- [x] Pre-hook runs before a step's core logic and can modify the context passed to it
- [x] Post-hook runs with both the original context and the step result
- [x] Hook errors abort the step and surface with the hook's identity in the error message
- [x] Hooks are testable in isolation
- [x] A single `StepContext` type flows through the pipeline, accumulating state; pipelines extend it with workflow-specific fields
- [x] `nested()` wraps a pipeline as a single step — the composite pattern used by Execute to embed the evaluator pipeline per-task
- [x] `parallelMap()` fans out N inner pipelines concurrently with shared `RateLimitCoordinator` + `SignalBus` lifecycle (framework primitive, adopted by Execute's inner loop in a follow-up phase)
- [x] `insertBefore(pipeline, targetName, newStep)` / `insertAfter(...)` / `replace(...)` pure builders allow extending pipelines without rewriting the step array
- [x] CLI commands and TUI views invoke pipeline factories (`createXxxPipeline`), never use cases directly — enforced by an ESLint `no-restricted-imports` fence
- [x] Integration tests under `src/business/pipelines/*.test.ts` assert `stepResults.map(r => r.stepName)` to lock each pipeline's step order
- [x] All use case functions return `Result<T, E>` from `typescript-result` — no throws at the use-case boundary
- [x] Domain errors carry a machine-readable `code` and optional `cause` (see `DomainError` subclasses)

## Structured Harness Signals

- [ ] Signal types are a fixed discriminated union in `src/domain/signals.ts` (Progress | Evaluation | TaskComplete | TaskVerified | TaskBlocked | Note)
- [ ] Adding a signal type requires a code change — the compiler enforces exhaustiveness via `_exhaustive: never`
- [ ] `<progress><summary>…</summary><files>…</files></progress>` parses to a `ProgressSignal`
- [ ] `<evaluation-passed>` / `<evaluation-failed>critique</evaluation-failed>` parses to an `EvaluationSignal` with status + dimensions
- [ ] `<task-verified>` / `<task-complete>` / `<task-blocked>` / `<note>` all parse to their own typed variants
- [ ] Unrecognized or malformed signals log a warning and continue — no crash
- [ ] Signals are accepted in any emission order; ordering is the pipeline's concern

## Harness-Owned Output Writes

- [ ] The harness (never the AI agent) writes to `progress.md`, `evaluations/<taskId>.md`, and `tasks.json`
- [ ] Parsed `ProgressSignal`s append a timestamped markdown entry to `progress.md`
- [ ] Parsed `EvaluationSignal`s append full critique to `evaluations/<taskId>.md`; preview (≤2000 chars) mirrored in `tasks.json`
- [ ] Append-only writes — harness crash mid-write leaves prior entries intact (resumable)
- [ ] File locks prevent concurrent corruption of `progress.md`

## Config Schema — Single Source of Truth

- [ ] All config options defined in one typed schema at `src/domain/config-schema.ts` (key, type, default, description, validation)
- [ ] `getAllSchemaEntries()` returns every config key — adding a key is a single schema edit
- [ ] Settings panel rows are generated from `getAllSchemaEntries()` automatically
- [ ] `config show` output is derived from the same schema
- [ ] `doctor` validates persisted config values against each key's validation rule
- [ ] `validateConfigValue(key, value)` is reused by CLI `config set` and the Ink settings panel

## Live Config (No Snapshot)

- [ ] `ExecuteTasksUseCase.getEvaluationConfig()` reads `PersistencePort.getConfig()` fresh on each task settlement
- [ ] No config value is snapshotted at sprint-start time
- [ ] Changing `evaluationIterations` via the settings panel mid-execution applies to the next task without restart
- [ ] Settings panel is accessible during execution

## Incremental Migration

- [ ] Each architectural phase (Clean Architecture, signals, logging, Ink TUI) shipped independently
- [ ] `pnpm typecheck && pnpm lint && pnpm test` passes at every commit boundary
- [ ] Existing CLI commands keep the same user-facing behaviour across phase boundaries
- [ ] No parallel UX architecture after Phase 4 — `src/interactive/` deleted, `ora` dependency removed, only `@inquirer/prompts` gateway remains for plain-text CLI prompts

## Project Lifecycle

- [ ] Projects have unique slug names
- [ ] Projects require at least one repository
- [ ] Repository paths are validated as existing directories
- [ ] Projects can be removed only if not referenced by tickets

## Sprint Lifecycle

- [ ] New sprint starts as `draft`
- [ ] Only `draft` sprints can have tickets/tasks added
- [ ] `sprint start` auto-activates draft sprints
- [ ] Multiple sprints can be `active` at a time (parallel usage)
- [ ] Only `active` sprints can have task status updated
- [ ] `closed` sprints cannot be modified
- [ ] Sprint closure warns if tasks incomplete

## Ticket Flow

- [ ] Tickets require `projectName` referencing existing project
- [ ] Tickets get auto-generated internal `id`
- [ ] `requirementStatus` starts as `pending`
- [ ] `sprint refine` clarifies requirements (no code exploration)
- [ ] `sprint refine` sets `requirementStatus` to `approved`
- [ ] `sprint plan` proposes affected repos based on requirements
- [ ] `sprint plan` requires all tickets `approved`
- [ ] Repository selection saved to `ticket.affectedRepositories` during planning
- [ ] `sprint ideate` creates ticket and generates tasks in one session
- [ ] `sprint ideate` auto-assigns ticketId to generated tasks
- [ ] `sprint ideate` handles bare tasks array output (requirements treated as empty)
- [ ] `sprint ideate` runs `reorderByDependencies` after task import

## Incremental Planning (Re-plan)

- [ ] `sprint plan` auto-detects existing tasks — no special flag needed
- [ ] When tasks exist, all tickets AND existing tasks are passed as AI context
- [ ] AI generates a complete task set (can modify, update, reorder, or add tasks)
- [ ] Imported tasks replace all existing tasks (safe — draft tasks are always `todo`)
- [ ] Re-plan stays draft-only — no active sprint relaxations
- [ ] `reorderByDependencies` runs after every import (initial or re-plan)
- [ ] Duplicate task order numbers are detected by `sprint health`

## Task Execution

- [ ] Tasks execute in dependency order
- [ ] Independent tasks run in parallel (one per projectPath)
- [ ] `in_progress` tasks resume on restart
- [ ] Completion signals parsed correctly
- [ ] Blocked tasks pause execution
- [ ] Verification required before completion (headless mode)
- [ ] `checkScript` runs at sprint start
- [ ] `checkScript` runs after every task completion as a post-task gate
- [ ] Task not marked done if check gate fails
- [ ] Rate-limited tasks auto-resume via session ID
- [ ] Structured exit codes for scripting integration

## Evaluator Pattern

- [ ] Evaluator runs after task completion + check gate pass (not on check failure)
- [ ] Evaluator uses model ladder (Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku)
- [ ] Copilot evaluator spawns without model override (no model control)
- [ ] `evaluationIterations` config controls max evaluation rounds (default: 1)
- [ ] Failed evaluation resumes generator with critique, re-checks, re-evaluates
- [ ] Evaluation never blocks task completion — task always proceeds to `done`
- [ ] `--no-evaluate` flag skips evaluation for a single run
- [ ] Session/interactive mode disables evaluation
- [ ] `evaluationOutput` truncated to 2000 chars before persisting
- [ ] `evaluated` field set to `true` after evaluation runs
- [ ] `doctor` warns when `evaluationIterations` is not configured
- [ ] `config set evaluationIterations` and `config show` work correctly

## Branch Management

- [ ] `sprint start` prompts for branch strategy on first run (keep current, auto, custom)
- [ ] `--branch` flag auto-generates `ralphctl/<sprint-id>` branch name
- [ ] `--branch-name <name>` sets a custom branch name
- [ ] Branch is created in all repos with remaining tasks
- [ ] Uncommitted changes in any repo fail-fast before branch creation
- [ ] Branch name persisted to `sprint.branch` for resume
- [ ] Subsequent runs skip prompt and use saved branch
- [ ] Pre-flight branch verification before each task execution
- [ ] `sprint show` displays branch when set
- [ ] `sprint health` checks branch consistency across repos
- [ ] `sprint close --create-pr` creates PRs for sprint branches
- [ ] Agent context includes branch section telling agent which branch it's on

## Doctor (Environment Health)

- [ ] Checks Node.js version >= 24.0.0
- [ ] Checks `git` is installed and in PATH
- [ ] Warns (not fails) when git identity (`user.name`/`user.email`) is missing
- [ ] Checks configured AI provider binary (`claude` or `copilot`) is in PATH
- [ ] Skips AI provider check when no provider is configured
- [ ] Verifies data directory is accessible and writable
- [ ] Validates all registered project repository paths exist and are git repos
- [ ] Validates current sprint file exists and parses correctly
- [ ] Skips sprint check when no current sprint is set
- [ ] Sets non-zero exit code on failures (warnings don't affect exit code)

## Multi-Project Support

- [ ] Projects can have multiple repositories
- [ ] Tickets reference projects by name
- [ ] Tasks get projectPath from ticket's project
- [ ] Each task executes in its assigned project path

## Terminal UI (Ink TUI)

- [ ] Bare `ralphctl` mounts the Ink-based REPL on TTY environments
- [ ] `ralphctl interactive` mounts the same REPL explicitly
- [ ] Non-TTY / piped stdout / `CI=1` / `RALPHCTL_JSON=1` / `RALPHCTL_NO_TUI=1` disables Ink and falls back to plain text
- [ ] In-TTY menu selections dispatch to the matching command action and return to the menu afterwards
- [ ] Pressing `s` from any view opens the settings panel overlay; Esc closes it
- [ ] `q` exits the REPL; Ctrl+C cancels the currently pending prompt
- [ ] One-shot CLI commands (`sprint show`, `config show`, `project list`, etc.) never mount Ink

## Live Execution Dashboard

- [ ] `ralphctl sprint start <id>` on TTY mounts the Ink dashboard and starts execution automatically
- [ ] Task grid renders one row per task with status indicator, name, and project path
- [ ] Progress signals update the "current activity" line for the originating task in real time
- [ ] Parallel task statuses update independently per task
- [ ] Rate-limit pause/resume events render a banner; banner disappears when the coordinator resumes
- [ ] A rolling log tail shows the most recent events (default 200-event cap)
- [ ] Execution completion shows summary counts (`completed`, `remaining`, `blocked`) and the `stopReason`
- [ ] When all tasks finish successfully, user is prompted via the Ink confirm component whether to close the sprint
- [ ] Non-TTY fallback runs the same use case with `PlainTextSink` output (no React)

## Settings Panel

- [ ] Panel is driven by `getAllSchemaEntries()` — adding a new config key produces a new row automatically
- [ ] Each row shows the key, current value, and one-line description
- [ ] `enum` keys open a `SelectPrompt`; `boolean` keys open a `ConfirmPrompt`; `integer`/`number`/`string` keys open an `InputPrompt`
- [ ] Inline validation errors from `validateConfigValue()` render below the row until the value is fixed
- [ ] When the current value matches the schema default, the row shows a "default" marker
- [ ] Valid edits save immediately via `PersistencePort.saveConfig()` — no explicit "save" action
- [ ] Panel is accessible during sprint execution (`s` key); edits apply to the next task (REQ-12)
- [ ] Esc closes the panel and returns to the underlying view

## Inline Text Editor (Claude-Code Style)

- [ ] Multi-line text input renders bottom-anchored inline — no external editor spawn
- [ ] Ctrl+D submits; Esc or Ctrl+C cancels (resolves to `null`)
- [ ] Enter inserts a newline in the buffer
- [ ] Left/Right/Up/Down keys move the cursor across lines and columns
- [ ] Ctrl+A jumps to start of line; Ctrl+E jumps to end of line
- [ ] Backspace/Delete remove the character before/at cursor; merges with previous line when at column 0
- [ ] Pasted multi-character chunks are split on `\n` and inserted as new lines at the cursor
- [ ] Used for ticket descriptions, requirement editing, and any multi-line text input in the Ink flow

## Prompt Abstraction (PromptPort)

- [ ] All call sites use `getPrompt()` from `src/application/bootstrap.ts` — no direct `@inquirer/prompts` imports outside `src/integration/prompts/inquirer-adapter.ts`
- [ ] `InquirerPromptAdapter` is the default; `InkPromptAdapter` swapped in by `mountInkApp()`
- [ ] `select`/`confirm`/`input`/`checkbox` throw `PromptCancelledError` on Ctrl+C/Escape
- [ ] `editor`/`fileBrowser` return `null` on cancel
- [ ] Parallel prompts queue serially — only the head prompt renders; others wait in FIFO order (InkPromptAdapter mutex)

## Signal Bus & Observability (SignalBusPort)

- [ ] `ExecuteTasksUseCase` emits on every parsed signal, rate-limit pause/resume, and task lifecycle event
- [ ] `InMemorySignalBus` micro-batches emissions within ~16 ms (one animation frame) to prevent render storms
- [ ] `FileSystemSignalHandler` (durable writes) and the Ink dashboard both subscribe — two sinks, one source
- [ ] Subscribers receive events in emission order
- [ ] Listener errors in one subscriber never stall delivery to others
- [ ] `dispose()` on shutdown drains buffers and drops subscribers

## Logger Sinks (LoggerPort)

- [ ] `PlainTextSink` on TTY one-shot CLI — ANSI-colored, human-readable stdout
- [ ] `JsonLogger` on non-TTY / piped / CI — one JSON object per line with `{level, message, timestamp, ...context}`
- [ ] `InkSink` when Ink is mounted — publishes to the log event bus; never writes stdout directly (would corrupt frames)
- [ ] `RALPHCTL_LOG_LEVEL=debug|info|warn|error` filters output in all three sinks
- [ ] Test environment (`VITEST=1`) silences info/warn output automatically
- [ ] `logger.child({sprintId, taskId, projectPath, step})` scopes context for nested use cases
- [ ] `logger.time(label)` returns a stop-function that logs elapsed ms at debug level

## Feedback Loop (Optional)

- [ ] Runs only after all tasks complete successfully (`stopReason === 'all_completed'`)
- [ ] Disabled by `--no-feedback` flag
- [ ] Disabled implicitly by `--session` mode
- [ ] Empty feedback input exits the loop without AI spawn
- [ ] Non-empty feedback spawns AI implementation, re-runs check scripts, re-evaluates
- [ ] Hard cap: `MAX_FEEDBACK_ITERATIONS` — proceeds to sprint close after the cap with a warning
