# RalphCTL - Agent Harness for AI Coding Tasks

@.claude/docs/REQUIREMENTS.md - Acceptance criteria + UI contract
@.claude/docs/ARCHITECTURE.md - Data models, file storage, error/exit tables

## Quick Start

```bash
# Install dependencies
pnpm install

# Run CLI in dev mode
pnpm dev --help
pnpm dev sprint create

# Or run installed CLI (works from any directory)
./bin/ralphctl

# Run without args for the Ink-based terminal app (recommended)
pnpm dev
```

Before committing any code change, run `/verify` (wraps `pnpm typecheck && pnpm lint && pnpm test`). All three must pass.

## Requirements

- **Node.js 24+** (managed via `mise.toml`)
- **pnpm 10+**
- **Claude CLI** or **GitHub Copilot CLI** installed and configured (see Provider Configuration below)

## Architecture Constraints

- **No `sprint activate` command** — `sprint start` auto-activates draft sprints
- **`affectedRepositories` stores absolute paths** (not names) — set during `sprint plan`, persisted per-ticket
- **Refinement is per-ticket** — template uses `{{TICKET}}` (singular), one AI session per ticket
- **Planning is per-sprint** — repo selection applies to all tickets, paths saved per-ticket
- **`currentSprint`** (config.json pointer) is NOT the same as sprint status (lifecycle state)
- **`aiProvider`** is a global config setting, not per-sprint — stored in config.json
- **Check scripts come ONLY from explicit repo config** — set during `project add` or `project repo add`; heuristic
  detection (`src/integration/external/detect-scripts.ts`) is used only as editable suggestions during project setup,
  never as a runtime fallback
- **`RALPHCTL_SETUP_TIMEOUT_MS`** — env var to override the 5-minute default timeout for check scripts
- **Check tracking** — `sprint.checkRanAt` records per-repo timestamps; re-runs skip already-completed checks;
  `--refresh-check` forces re-execution; cleared on sprint close
- **Post-task gate** — harness runs `checkScript` after every AI task; task not marked done if gate fails
- **Branch management** — `sprint start` prompts for branch strategy on first run; `sprint.branch` persists the choice;
  branches created in all repos with tasks; pre-flight verifies correct branch before each task; `--branch`
  auto-generates `ralphctl/<sprint-id>`; `--branch-name <name>` for custom names; `sprint close --create-pr` creates PRs
- **Evaluator pattern** — independent code review after each task (see REQUIREMENTS.md § Evaluator Pattern for full spec):
  - `evaluationIterations` is global (config.json). Default `1` = 1 initial eval + up to 1 fix-and-reeval. `0` disables.
  - Claude uses a model ladder (Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku); Copilot uses the same model (no control).
  - Evaluator is autonomous (full tool access) and grades four floor dimensions (Correctness / Completeness / Safety /
    Consistency) plus optional `extraDimensions` emitted per-task by the planner (undefined = floor-only).
  - Full critique persists to `<sprintDir>/evaluations/<taskId>.md`; `tasks.json` keeps a 2000-char preview + status.
  - Evaluator **never blocks** — task always completes; `--no-evaluate` skips for one run; session mode disables it.
- **Result boundaries** — Persistence layer functions throw domain errors. Result types (`wrapAsync`, `zodParse`) are
  used at command/interactive boundaries to handle errors without throwing. Prefer `.ok` property checks over
  `.match()` chains.
- **Clean Architecture layering** — `domain` < `business` < `integration` < `application`. Inner layers never import
  from outer layers. Use cases depend on service ports (`src/business/ports/`); repository interfaces are pure-domain
  (every port lives in `src/business/ports/`). Concrete adapters live under `src/integration/`.
- **Pipelines are the orchestration layer** — every user-triggered workflow (refine, plan, ideate, evaluate, execute)
  is a composable `PipelineDefinition` in `src/business/pipelines/`, composed via `pipeline()` / `step()` from
  `src/business/pipelines/framework/helpers.ts` with shared building blocks in `src/business/pipelines/steps/`. CLI
  commands and TUI views invoke `createXxxPipeline()` factories from `src/application/factories.ts` and call
  `executePipeline(...)` — never `useCase.execute()` directly. An ESLint `no-restricted-imports` fence in
  `eslint.config.js` enforces the boundary (type-only imports allowed).
- **Pipeline framework primitives** — extend with `insertBefore` / `insertAfter` / `replace` (pure builders) rather
  than rewriting the step array. Use `nested(pipeline)` to embed one pipeline as a step of another (composite
  pattern); use `forEachTask()` to fan out an inner pipeline per item with mutex-keyed concurrency, retry policy,
  and a shared rate-limit coordinator + signal-bus lifecycle.
- **Integration tests lock step order** — each pipeline has a test under `src/business/pipelines/*.test.ts` that
  asserts `stepResults.map(r => r.stepName)` on the happy path and failure paths. These tests are the architectural
  fence that prevents silent bypass — docs alone aren't enforcement.
- **No barrel files** — every import points to the source module directly. Never add an `index.ts` that only
  re-exports from siblings; tree-shaking and import clarity beat brevity at the call site.
- **Ink TUI is the default interactive surface** — bare `ralphctl` / `ralphctl interactive` / `ralphctl sprint start`
  mount the Ink app via `src/integration/ui/tui/runtime/mount.tsx`. The mount path takes over the terminal using the
  alt-screen buffer (vim/htop-style) and restores it on exit via `src/integration/ui/tui/runtime/screen.ts`. Non-TTY /
  CI / piped invocations fall back automatically to Commander + PlainTextSink.
- **PromptPort is the only interactive-prompt abstraction** — call sites use `getPrompt()` from
  `src/integration/bootstrap.ts`. `InkPromptAdapter` is the single implementation. When a prompt fires and the full
  dashboard isn't mounted (one-shot commands like `ralphctl project add`), the adapter auto-mounts a minimal Ink tree
  via `src/integration/ui/prompts/auto-mount.tsx` containing only `<PromptHost />`, drains the prompt queue, and
  unmounts. Non-interactive environments throw `PromptCancelledError` — pass values as flags.
- **LoggerPort is the only logging abstraction** — three sinks: `PlainTextSink` (TTY one-shot CLI), `JsonLogger`
  (non-TTY / piped / CI), `InkSink` (Ink-mounted, publishes to an event bus consumed by the dashboard). Business logic
  always goes through the injected logger, never `console.log`.
- **SignalBusPort is the live observability stream** — `ExecuteTasksUseCase` emits on every parsed signal, rate-limit
  pause/resume, and task lifecycle event. Dashboard subscribes to render live; filesystem signal handler subscribes to
  persist. Two sinks, one source — `InMemorySignalBus` micro-batches emissions at ~16ms to avoid render storms.
- **Live config (no snapshot)** — `ExecuteTasksUseCase.getEvaluationConfig()` reads fresh per task settlement so
  mid-execution changes via the settings panel (REQ-12) take effect on the next task without restart.

## Common Mistakes to Avoid

- Don't reference or create a `sprint activate` command — use `sprint start`
- Don't confuse `currentSprint` (which sprint CLI targets) with `sprintStatus` (draft/active/closed)
- Don't store repository names in `affectedRepositories` — store absolute paths
- Don't explore repos during `sprint refine` — refinement is implementation-agnostic (WHAT, not HOW)
- Don't break task `blockedBy` dependencies during planning — preserve dependency chains
- Don't let prompt templates drift from command implementation — verify prompts describe actual workflow (e.g., repo
  selection timing)
- Don't hardcode provider-specific logic outside `src/integration/ai/providers/` — use the provider abstraction layer
- Don't assume both providers share the same permission model — Claude uses settings files, Copilot uses
  `--allow-all-tools` (see Provider Differences below)
- Don't add runtime auto-detection of check scripts — detection logic in `src/integration/external/detect-scripts.ts` is
  for suggestions during `project add` only
- Don't skip file locks for data mutations — use `withFileLock()` to prevent race conditions in concurrent access (30s
  timeout, configurable via `RALPHCTL_LOCK_TIMEOUT_MS`)
- Don't add `index.ts` barrel files — every import goes directly to its source module
- Don't import `@inquirer/prompts` — it's deleted. Use `getPrompt()` from `src/integration/bootstrap.ts`
- Don't call use cases from CLI commands or TUI views — ESLint fence blocks it. Use
  `createXxxPipeline()` from `src/application/factories.ts` + `executePipeline(...)` instead.
- Don't invent new pipeline orchestration primitives — the framework has `step`/`pipeline`/`nested`/`forEachTask`/
  `insertBefore`/`insertAfter`/`replace`/`renameStep` in `src/business/pipelines/framework/`. Use them.

## Workflow

```
0. Check setup        → ralphctl doctor (environment health check)
1. Add projects       → ralphctl project add
2. Create sprint      → ralphctl sprint create (draft, becomes current)
3. Add tickets        → ralphctl ticket add --project <name>
4. Refine requirements → ralphctl sprint refine (WHAT — clarify requirements)
5. Export requirements → ralphctl sprint requirements (optional, markdown export)
6. Plan tasks         → ralphctl sprint plan (HOW — explore repos, generate tasks)
7. Check health       → ralphctl sprint health (diagnose blockers, stale tasks)
8. Start work         → ralphctl sprint start (auto-activates draft sprints)
9. Close sprint       → ralphctl sprint close
```

**Optional:** Enable shell tab-completion with `ralphctl completion install` (bash, zsh, fish).

**Optional:** Configure your preferred AI provider with `ralphctl config set provider <claude|copilot>` (prompted on
first use if not set).

### Provider Configuration

```bash
ralphctl config set provider claude      # Use Claude Code CLI
ralphctl config set provider copilot     # Use GitHub Copilot CLI
```

Auto-prompts on first AI command if not set. Both CLIs must be in PATH and authenticated.

### Provider Differences

| Aspect              | Claude Code                                              | GitHub Copilot      |
| ------------------- | -------------------------------------------------------- | ------------------- |
| CLI flags           | `--permission-mode acceptEdits`, `--effort xhigh`        | `--allow-all-tools` |
| Settings files      | `.claude/settings.local.json`, `~/.claude/settings.json` | None                |
| Allow/deny patterns | `Bash(git commit:*)`, `Bash(*)`, etc.                    | Not applicable      |

`--effort xhigh` matches Claude Code's own default for plans (Opus 4.7 introduced the `xhigh` level between `high` and
`max`). Older Claude models accept `--effort` too; the CLI maps the level down to what the selected model supports.

### Workflow Paths

**Direct Tasks:** `sprint create` → `task add` (repeat) → `sprint start`
**AI-Assisted:** `sprint create` → `ticket add` → `sprint refine` → `sprint plan` → `sprint start`
**Quick Ideation:** `sprint create` → `sprint ideate` → `sprint start` (combines refine + plan for quick ideas)
**Re-Plan:** (draft sprint) `ticket add` → `sprint refine` → `sprint plan` (replaces existing tasks)

## Sprint State Machine

Status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add ticket          |   ✓   |   ✗    |   ✗    |
| Edit/remove ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
| Ideate (quick)      |   ✓   |   ✗    |   ✗    |
| Plan tasks          |   ✓   |   ✗    |   ✗    |
| Start (execute)     |  ✓\*  |   ✓    |   ✗    |
| Update task status  |   ✗   |   ✓    |   ✗    |
| Close               |   ✗   |   ✓    |   ✗    |

\*`sprint start` auto-activates draft sprints.

## Two-Phase Planning

**Phase 1: Requirements Refinement** (`sprint refine`) — WHAT needs doing

- Per-ticket HITL clarification: Claude asks questions, user approves requirements
- **Implementation-agnostic** — no code exploration, no repo selection
- Stores results as `requirementStatus: 'approved'` on each ticket

**Phase 2: Task Generation** (`sprint plan`) — HOW to implement

- Requires all tickets to have `requirementStatus: 'approved'`
- User selects repos via checkbox UI (before Claude starts) → saved to `ticket.affectedRepositories`
- Claude explores confirmed repos only → generates tasks split by repo with dependencies
- Repo selection persists for resumability

### Draft Re-Plan

Running `sprint plan` on a draft sprint that already has tasks triggers re-plan mode:

1. Add new tickets to the draft sprint (`ticket add`)
2. Refine their requirements (`sprint refine`)
3. Run `sprint plan` — auto-detects existing tasks

**Behavior:**

- Processes ALL tickets (not just unplanned ones)
- Existing tasks are included as AI context so Claude can reuse, modify, or drop them
- AI generates a complete replacement task set covering all tickets
- New tasks atomically replace all existing tasks via `saveTasks()` (interruption-safe)
- `reorderByDependencies` runs after every import
- Interactive mode shows confirmation prompt before replacing

## Development

```bash
pnpm dev <command>     # Run CLI (tsx, no build needed)
pnpm build             # Compile for npm distribution (tsup)
pnpm typecheck         # Type check
pnpm lint              # Lint
pnpm test              # Run tests
```

### Git Hooks

Pre-commit hook runs `lint-staged` (ESLint + Prettier on staged files). If commits are rejected, run:

```bash
pnpm lint:fix    # Auto-fix linting issues
pnpm format      # Format all files
```

## Prompt Template Engineering

**Conditional sections** - `{{VARIABLE}}` placeholders in prompts can be empty strings; avoid numbered lists that create
gaps (use blockquotes or bullets)
**Em-dash usage** - Use `—` (em-dash) not `-` (hyphen) for explanatory clauses in `.md` prompts (consistency across all
prompt files)
**Workflow sync** - Prompt templates must match actual command flow (e.g., repo selection happens in command before
Claude session starts)
**Template builders** - `src/integration/ai/prompts/loader.ts` compiles `.md` templates with placeholder replacement
**Canonical XML vocabulary** — structural inputs sit inside known tags (`<harness-context>`, `<task-specification>`,
`<context>`, `<requirements>`, `<constraints>`, `<examples>`, `<dimension>`, `<signals>`). Full table in
[.claude/docs/PROMPT-AUDIT.md](.claude/docs/PROMPT-AUDIT.md) — extend both the doc and the loader audit tests when
adding a new tag.
**No hardcoded package-manager commands** — prompts must not embed `pnpm`/`npm`/`pip`/`cargo`/`go test` outside the
`{{PROJECT_TOOLING}}` or `{{CHECK_GATE_EXAMPLE}}` placeholders. Downstream ecosystems differ; the placeholders are the
seam.
**Conditional placeholders must not sit inside numbered lists** — when the substitution is empty the list must still
read cleanly. Emit conditional content as a standalone bullet or paragraph, not as trailing prose in a numbered step.
**Downstream `.claude/` is optional context** — many downstream repos have no `.claude/` directory. Reference it as
"when present" rather than prescriptively; skip silently when absent.
**Absolute rules name their exception** — `never`/`always` phrasing is fragile when legitimate exceptions exist. Name
the exception inline (e.g. "Merge create+use — except when a stable contract makes them independently testable").

## Custom Agents

Six specialized agents in `.claude/agents/` (auditor, designer, implementer, planner, reviewer, tester) — invoke via
the Task tool with the matching `subagent_type`. These are contributor-side tooling for working on ralphctl's own
source; they are not shipped to npm and do not affect ralphctl's runtime behavior.

## UI Patterns

**Two UI surfaces — pick the right one for the command:**

- **Ink TUI** (`src/integration/ui/tui/`) — live dashboard, REPL, settings panel, inline editor. Mounted by bare
  `ralphctl`, `ralphctl interactive`, and `ralphctl sprint start`. Takes over the terminal via the alt-screen buffer
  (like vim/htop) and restores on exit. Uses `@inkjs/ui` components + the `LoggerPort` event bus for live-updating
  output.
- **Plain-text CLI** — one-shot commands (`sprint show`, `config set`, `project add`, etc.) use `PlainTextSink` for
  structured logging plus the pure formatters in `@src/integration/ui/theme/ui.ts` (grep `^export` there for the full
  roster — card / table / status / success / warning / info / field / progress families). When a prompt fires, the
  `InkPromptAdapter` auto-mounts a minimal `<PromptHost />` inline — no Inquirer.

Never add raw emoji or inconsistent formatting — use `emoji`/`colors`/`statusEmoji` from
`@src/integration/ui/theme/theme.ts` and the formatters from `@src/integration/ui/theme/ui.ts`. Ink components pull
theme tokens via `@src/integration/ui/theme/tokens.ts`.

**The Ink TUI has a design system** — see [`.claude/docs/DESIGN-SYSTEM.md`](.claude/docs/DESIGN-SYSTEM.md) before
adding a view, component, or glyph. It covers the token set (`inkColors` / `glyphs` / `spacing`), component inventory,
state surfaces (loading / empty / error / success), navigation contract, copy rules, and anti-patterns. Most needs are
already solved — reuse `ViewShell` + `ResultCard` + `FieldList` + `Spinner` before inventing.

See `.claude/agents/designer.md` for the designer agent's role.

### Repository layout

See [`ARCHITECTURE.md § Clean Architecture Layers`](.claude/docs/ARCHITECTURE.md) for the annotated `src/` tree and
the per-port adapter map. Top-level: `domain/` (pure) → `business/` (ports, usecases, pipelines) → `integration/`
(adapters, UI, CLI) → `application/` (composition root).

## Task Execution Signals

See `ARCHITECTURE.md § Harness Signals` and `src/domain/signals.ts`. Adding a variant to the `HarnessSignal` union
triggers compiler exhaustiveness errors everywhere — let the type system guide the edit. Signals flow to two
subscribers in parallel: `FileSystemSignalHandler` (durable) + `SignalBusPort` (live dashboard).

## Feedback Loop

Optional, opt-out, runs only after all tasks complete successfully (`src/business/usecases/execute.ts`):

- Fires when `summary.stopReason === 'all_completed'` AND `!options.session` AND `!options.noFeedback`
- User types free-form feedback; empty input exits the loop immediately
- AI implements the feedback, check scripts re-run, evaluator re-runs
- Hard cap: `MAX_FEEDBACK_ITERATIONS` (safety net against infinite loops)
- Disable per-run with `--no-feedback`; disabled implicitly in `--session` mode
- Dirty working tree after a feedback iteration triggers the same harness auto-commit as post-task settlement (see recover-dirty-tree).

## Parallel Execution

`sprint start` runs tasks in parallel by default (one per unique `projectPath`):

- Session/step mode forces sequential (`--concurrency 1` equivalent)
- **Rate limiting:** `RateLimitCoordinator` pauses new task launches globally when any task hits a rate limit; running tasks continue uninterrupted
- Rate-limited tasks auto-resume via `--resume <session_id>` (full session context preserved)
- Errors with rate-limit headers (429, 429-style responses) trigger coordinator pause automatically

## Environment Variables

Customize ralphctl behavior with these environment variables:

| Variable                    | Default        | Range                         | Purpose                                                                       |
| --------------------------- | -------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `RALPHCTL_ROOT`             | `~/.ralphctl/` | Any valid path                | Override data directory (e.g., for testing or multi-workspace setup)          |
| `RALPHCTL_SETUP_TIMEOUT_MS` | 300000 (5 min) | > 0                           | Timeout for check scripts; overridable per-repo via `Repository.checkTimeout` |
| `RALPHCTL_LOCK_TIMEOUT_MS`  | 30000          | 1–3600000                     | Stale lock file threshold for concurrent access detection                     |
| `RALPHCTL_LOG_LEVEL`        | `info`         | `debug`/`info`/`warn`/`error` | Filter structured-log output (PlainTextSink and JsonLogger)                   |
| `RALPHCTL_NO_TUI`           | unset          | any truthy value              | Force the plain-text CLI fallback even on a TTY (skip Ink mount)              |
| `RALPHCTL_JSON`             | unset          | any truthy value              | Force the `JsonLogger` sink (one JSON object per line) regardless of TTY      |
| `NO_COLOR`                  | unset          | any truthy value              | Suppress ANSI colors (honored by `isTTY()` and by `colorette`)                |
| `CI`                        | unset          | any truthy value              | Auto-detected; disables Ink mount and implicit interactive prompts            |
| `VISUAL` / `EDITOR`         | unset          | editor command                | Read by the editor resolver; the Ink inline editor is preferred on TTY.       |

**Note:** In tests, set `RALPHCTL_ROOT` BEFORE importing persistence modules (e.g., in setup file before `describe`
blocks).

## Build & Distribution

**Prompt templates are distributed with the CLI.** The build script copies `.md` files from
`src/integration/ai/prompts/` to `dist/prompts/`:

```bash
pnpm build  # Runs: tsup && mkdir -p dist/prompts && cp src/integration/ai/prompts/*.md dist/prompts/
```

Template loading is dual-mode:

- **Dev:** Reads from `src/integration/ai/prompts/*.md`
- **Bundled (npm):** Reads from `dist/prompts/*.md`

**Gotcha:** If `.md` files are missing in `dist`, templates silently fail with empty placeholder values (no file-not-found error). CI verifies dist works by testing `node dist/cli.mjs --version` from arbitrary cwd.

## Releasing

Releases are automated via GitHub Actions on git tags matching `v[0-9]+.[0-9]+.[0-9]+`:

1. Tag must match `package.json` version (e.g., tag `v0.2.2` requires `"version": "0.2.2"` in package.json)
2. **Changelog:** Add a `## [X.Y.Z]` section to `CHANGELOG.md` or release notes will fall back to git log
3. **NPM publish:** Uses provenance attestation (`--provenance`)
4. **GitHub release:** Auto-generated with changelog section + comparison link to previous tag
5. **Pre-release detection:** Tags containing `-` (e.g., `v1.0.0-beta`) are marked as prerelease

## Compaction Rules

When compacting, always preserve: sprint state machine, two-phase planning constraints, architecture constraints, list
of modified files, verification commands, and current task context.

## References

- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) —
  consult when extending the runner/executor layer.
- [Anthropic — Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) —
  generator-evaluator pattern, context management, iterative refinement, and model-specific tuning strategies.
