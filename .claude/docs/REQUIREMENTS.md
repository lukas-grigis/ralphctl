# RalphCTL - Acceptance Criteria

Testable acceptance criteria for all features. For constraints, see the root CLAUDE.md. For data models,
see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Clean Architecture & Composable Pipelines

- [x] Dependencies point inward only: domain < business < integration < application. Inner layers never import outer
- [x] Use cases depend on ports (all interfaces live in `src/business/ports/`), never on concrete adapter classes
- [x] Every user-triggered workflow (refine, plan, ideate, evaluate, execute) is a composable pipeline in `src/business/pipelines/`
- [x] Pipelines compose named steps via `pipeline(name, steps[])` from `src/business/pipelines/framework/helpers.ts`
- [x] Shared steps in `src/business/pipelines/steps/` are reused across pipelines (load-sprint, assert-sprint-status, run-check-scripts, branch-preflight, etc.)
- [x] Pipeline failures stop execution and propagate with the failing step name via `StepError` (e.g., `Step 'assert-draft' failed: ...`)
- [x] Each step supports `pre` and `post` hooks as typed async functions registered in the step definition
- [x] Pre-hook runs before a step's core logic and can modify the context passed to it
- [x] Post-hook runs with both the original context and the step result
- [x] Hook errors abort the step and surface with the hook's identity in the error message
- [x] Hooks are testable in isolation
- [x] A single `StepContext` type flows through the pipeline, accumulating state; pipelines extend it with workflow-specific fields
- [x] `nested()` wraps a pipeline as a single step — the composite pattern used by Execute to embed the evaluator pipeline per-task
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
- [ ] No parallel UX architecture after Phase 4 — `src/interactive/` deleted, `ora` and `@inquirer/prompts` dependencies removed; `InkPromptAdapter` is the single `PromptPort` implementation, auto-mounting a minimal host for one-shot CLI prompts

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
- [ ] Evaluator grades the four floor dimensions on every task (Correctness / Completeness / Safety / Consistency)
- [ ] Tasks may carry an optional `extraDimensions: string[]` emitted by the planner for non-default success criteria
- [ ] Extra dimensions render as additional `**Dimension N — <Name>**` blocks in the evaluator prompt
- [ ] `extraDimensions: undefined` means floor-only — no extra blocks rendered, no orphan placeholders

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

- [ ] All call sites use `getPrompt()` from `src/application/bootstrap.ts` — no direct `@inquirer/prompts` imports anywhere
- [ ] `InkPromptAdapter` is the only implementation; one-shot CLI commands auto-mount a minimal `<PromptHost />` on demand
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

---

# UI Contract

The contract every TUI view follows. Goal: the app feels written from one hand — same layout, same keys, same
language on every screen. Changes to TUI primitives MUST update this section.

> **Full design system:** [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) is the canonical reference — tokens, component
> inventory, state surfaces, copy rules, anti-patterns, and the "when to extend vs reuse" ladder. This section holds
> the **testable** version of that system (what a reviewer can check off); read the design system first for the why.

## Design intent — "Technical Letterpress"

Typography is the workhorse: bold + dim carry hierarchy, color carries semantic state. Ralph personality is
concentrated in the banner, not smeared across every view. Glyphs are a curated, consistent family — ■ ◆ ◇ ▸ ▣ ━ │ ↳ ◌
and the braille spinner.

## Anatomy of a view

Every view mounts through `<ViewShell>`:

```
┌─ ViewShell ─────────────────────────────────────┐
│  <SectionStamp title="VIEW TITLE" />            │ ← header (always)
│                                                 │
│  <body>  ← the view-specific content            │
│                                                 │
│  <PromptHost />  ← inline prompts (auto)        │
│                                                 │
│  <KeyboardHints />  ← view-local hints (auto)   │
└─────────────────────────────────────────────────┘
<StatusBar>  ← owned by the router (breadcrumb + global hotkeys)
```

Views never render their own header box, spacing boxes between sections, or hint footer. `ViewShell` owns all three.

## Keyboard contract

**Global hotkeys** — owned by the router, work from EVERY view:

- `Esc` — pop one frame (no-op at root)
- `h` — home
- `s` — settings
- `d` — dashboard
- `q` — quit (home root only)

**View-local keys** — declared via `useViewHints()`. Common vocabulary:

- `↑/↓` — move cursor
- `←/→` — switch panes / previous/next page
- `Enter` — confirm / open / run
- `Space` — toggle / multi-select
- `Tab` / `Shift+Tab` — next / prev field
- `Ctrl+D` — submit multi-line editor
- A single letter (`b`, `r`, `n`, …) — primary view action, always shown in hints

**Rules:**

- Any undocumented key is a bug. If a view responds to it, hint for it.
- `Enter` on a terminal/result state pops the view.
- `Esc` in a submode returns to the parent mode before being claimed by the router.

## Navigation

- **Workflow views** (add / edit / remove / configure): use `useWorkflow` hook. Phase discriminator drives spinner +
  result card. Enter on terminal → pop.
- **List views** (`browse/*-list-view.tsx`): `ListView` with `↑/↓ · Enter open · Esc back`.
- **Detail views** (`browse/*-show-view.tsx`): `FieldList` + `StatusChip` for metadata.
- **Phase views** (refine / plan / close / execute): behave like a workflow view — `<SectionStamp>`, `useWorkflow` (or
  `useWorkflow`-compatible state machine), `<ResultCard>` for the outcome. No bespoke input handlers.

## Prompts

- Always go through `getPrompt()` — no direct Ink input components in a view.
- `<PromptHost>` renders inside `<ViewShell>` between body and hints — not after the status bar, not before the header.
  (`ViewShell` owns placement.)
- Multi-step forms: set `phase.step` before each prompt so the spinner reflects what the user is answering.

## Spinner labels

Imperative, ends with a single ellipsis. Reserve the verb for the _action the harness is performing_, not what the user
is about to do.

- Do: `Loading sprints…` / `Saving ticket…` / `Fetching issue data…` / `Generating tasks…`
- Don't: `Type the title…` (that's a prompt hint, not a spinner state)
- Don't: `Waiting for sprint name…` (passive; rewrite as "Enter sprint name…" hint, not spinner)

When the view is idle waiting on a prompt, don't show a spinner. Show the prompt.

## States — one surface per kind

| State                   | Surface                         | Notes                                      |
| ----------------------- | ------------------------------- | ------------------------------------------ |
| Loading / running       | `<Spinner label="…" />`         | Warning color default; never bare text     |
| Empty (no data to show) | `<ResultCard kind="info" />`    | "No X yet" with a `nextSteps` pointer      |
| Precondition failed     | `<ResultCard kind="warning" />` | "Needs Y first" with a `nextSteps` pointer |
| Error                   | `<ResultCard kind="error" />`   | Carry `lines={[message]}`                  |
| Success                 | `<ResultCard kind="success" />` | `fields={…}` + `nextSteps={…}`             |

Never mix raw `<Text color="red">` with `ResultCard`. Pick a surface.

## Layout tokens

Every `marginTop` / `marginBottom` / `padding*` value must come from `tokens.spacing`:

- `spacing.section` — vertical gap between sections (= 1)
- `spacing.indent` — left-indent for nested content (= 2)
- `spacing.gutter` — padding inside card-like boxes (= 1)

No hardcoded numbers. ViewShell already spaces header → body → hints correctly; views only add spacing inside their
body.

## Glyphs

All symbols come from `tokens.glyphs`. Never inline a unicode character.

Canonical set:

- `phaseDone` (■), `phaseActive` (◆), `phasePending` (◇), `phaseDisabled` (◌)
- `actionCursor` (▸), `selectMarker` (›)
- `badge` (▣), `sectionRule` (━)
- `check` (✓), `cross` (✗)
- `warningGlyph` (⚠), `infoGlyph` (i)
- `inlineDot` (·), `emDash` (—), `arrowRight` (→), `activityArrow` (↳)
- `separatorVertical` (│)
- `spinner` (braille frames), `quoteRail` (┃)

## Colors

Semantic only. Never `color="red"` — always `inkColors.error`.

Palette lives in `inkColors` (`src/integration/ui/theme/tokens.ts`):

- `success` (sage) — completion, pass, done
- `error` (coral) — failure, blocked, fail
- `warning` (amber) — in-progress, draft, paused
- `info` (dusty cyan) — annotations, meta, help
- `muted` (warm gray) — secondary, inactive, disabled
- `highlight` (mustard) — focus, selection, "next" marker
- `primary` (mustard) — brand accent (section stamps)
- `secondary` (rose) — personality (quote rail)

**Focus pattern:** `{ color: inkColors.highlight, bold: true }` — apply inline; there is no shared `focus` token.

## View-hints contract (`useViewHints`)

Each view declares its keys once:

```tsx
useViewHints([
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
  { key: 'b', action: 'browse' },
]);
```

Hints render in `<KeyboardHints />` at the bottom of `<ViewShell>`. The StatusBar only ever shows _global_ hotkeys — no
more duplication.

Order: view-local hints first, global hotkeys second (owned by StatusBar below).

## Surfaces

- **Home** — the only screen that renders the Banner + pipeline map + sprint summary. Every other screen is a plain
  `<ViewShell>` — no banner, no hero. Keeps navigation cheap.
- **Dashboard** — read-only status destination. Shows task grid, blockers, sprint summary hero. `d` from anywhere.
  Escape pops back.
- **Execute** — live dashboard during sprint execution. Subscribes to `SignalBusPort` + log event bus. `s` still pushes
  settings on top (live-config edit lands on next task — REQ-12).
- **Settings** — `SettingsPanel` rows are generated from `getAllSchemaEntries()`. Editing a field saves immediately.
  Esc closes. View-local hints: `↑/↓ navigate · Enter edit`.

## Non-negotiables

- No view writes to `console.log` / stdout directly. Use the injected `LoggerPort`.
- No view calls a use case directly. Use pipeline factories.
- No view mounts a prompt outside `getPrompt()`.
- No view renders its own hint footer. Use `useViewHints()`.
- `pnpm typecheck && pnpm lint && pnpm test` must pass at every commit.
