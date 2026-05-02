# RalphCTL - Agent Harness for AI Coding Tasks

Version 0.6.0 — read from `package.json` at build time via the JSON import attribute in
`src/application/cli/entrypoint.ts`.

@.claude/docs/REQUIREMENTS.md - Acceptance criteria + UI contract
@.claude/docs/ARCHITECTURE.md - Layout, data models, file storage, error/exit tables
@.claude/docs/KERNEL-DESIGN.md - Chain framework reference (Element / Leaf / Sequential / Parallel / Retry / OnError)

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

- **Five-module Clean Architecture (`src/`)** — `kernel < domain < business < integration < application`. Both
  `kernel/` and `domain/` are pure leaves with zero IO; `business/` may import from either. Inner layers never import
  from outer layers. ESLint `no-restricted-imports` enforces every direction (see `eslint.config.js`).
- **Repositories are domain interfaces** — `ProjectRepository`, `SprintRepository`, `TaskRepository` live in
  `src/domain/repositories/`. Service ports (AiSession, External, Logger, Prompt, SignalBus, etc.) live in
  `src/business/ports/`. Concrete adapters live in `src/integration/`.
- **Chains are the orchestration layer** — every user-triggered workflow (refine, plan, ideate, execute, evaluate,
  feedback) is a `kernel/chain` `Element` composed in `src/application/chains/<name>/`. The framework primitives
  are `Element`, `Leaf` (the only seam to use cases), `Sequential`, `Parallel`, `Retry`, `OnError`. There are NO
  conditional / pipeline / step-builder helpers — branching belongs inside a use case or in a sub-chain selected by
  the caller. See `KERNEL-DESIGN.md` for the full contract.
- **Multi-chain runtime** — `SessionManager` (`src/application/runtime/session-manager.ts`) owns N concurrent
  `ChainRunner` instances. Users start, foreground, background, and kill sessions like tmux windows: Tab cycles,
  `Ctrl+1..9` jumps directly, `q` doesn't kill background runners. CLI parity: `ralphctl sessions list / attach / detach
/ kill`. Every workflow launch goes through `SessionManager.start({ element, initialCtx, label })` — never call
  `chain.execute()` directly.
- **Composition root** — `createSharedDeps(overrides?)` (`src/application/bootstrap/shared-deps.ts`) constructs
  every concrete adapter; `getSharedDeps()` / `setSharedDeps(deps)` (`bootstrap/get-shared-deps.ts`) are the singleton
  accessor + swap hook used by the Ink mount path. `getPrompt()` is the convenience accessor for the prompt port.
- **Result types** — every business operation returns `Result<T, DomainError>`. Import `Result` and `AsyncResult` from
  `src/domain/result.ts` (the canonical re-export point) — never reach into `typescript-result` directly.
- **No `sprint activate` command** — `sprint start` auto-activates draft sprints
- **`affectedRepositories` stores absolute paths** (not names) — set during `sprint plan`, persisted on `Sprint.affectedRepositories` (not per-ticket)
- **Refinement is per-ticket** — template uses `{{TICKET}}` (singular), one AI session per ticket; project name comes from the sprint, not from the ticket
- **Planning is per-sprint** — every sprint targets exactly one project (`Sprint.projectName`); repo selection runs inside the plan chain's `persist-repo-selection` leaf and is saved on `sprint.affectedRepositories`
- **`currentSprint`** (config.json pointer) is NOT the same as sprint status (lifecycle state)
- **`aiProvider`** is a global config setting, not per-sprint — stored in config.json
- **Check scripts come ONLY from explicit repo config** — set during `project add` or `project repo add`. Heuristic
  detection in `src/integration/external/` is used only as editable suggestions during project setup, never as
  a runtime fallback.
- **`RALPHCTL_SETUP_TIMEOUT_MS`** — env var to override the 5-minute default timeout for check scripts
- **Post-task gate** — the per-task chain runs the configured `checkScript` after every AI task; the task is not marked
  done if the gate fails (see `business/usecases/execute/post-task-check.ts`)
- **Branch management** — `sprint start` prompts for branch strategy on first run; `sprint.branch` persists the
  choice; branches created in all repos with tasks; pre-flight verifies correct branch before each task; `--branch`
  auto-generates `ralphctl/<sprint-id>`; `--branch-name <name>` for custom names; `sprint close --create-pr` creates PRs
- **Evaluator pattern** — independent code review after each task (see REQUIREMENTS.md § Evaluator Pattern):
  - `evaluationIterations` is global (config.json). `0` disables; `>= 1` enables N rounds with plateau detection.
    Inside the per-task chain the multi-round loop runs via `EvaluateAndFixLoopUseCase`
    (`src/business/usecases/evaluate/evaluate-and-fix-loop.ts`); the standalone `sprint evaluate` command still runs
    ONE round per invocation. The loop reader is `LiveConfigReader` (`src/application/runtime/live-config-reader.ts`)
    — config is re-read fresh per task settlement, so settings-panel edits land on the next task without restart.
  - Claude uses a model ladder (Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku); Copilot uses the same model (no control).
  - Evaluator grades four floor dimensions (Correctness / Completeness / Safety / Consistency) plus optional
    `extraDimensions` emitted per-task by the planner.
  - Full critique persists to `<sprintDir>/evaluations/<taskId>.md`; `tasks.json` keeps a 2000-char preview + status.
  - Evaluator **never blocks** — failure is wrapped in `OnError(catchIf: () => true, fallback: noop)` in the per-task
    chain, so the task always proceeds to `done` (or `blocked` via `markBlocked` when branch-preflight fails) and
    the chain continues.
- **Ink TUI is the default interactive surface** — bare `ralphctl` / `ralphctl interactive` / `ralphctl sprint start`
  mount the Ink app via `src/application/tui/runtime/mount.tsx`. The mount path takes over the terminal using the
  alt-screen buffer (vim/htop-style) and restores it on exit via `src/application/tui/runtime/screen.ts`. Non-TTY
  / CI / piped invocations fall back automatically to Commander + `PlainTextSink`.
- **PromptPort is the only interactive-prompt abstraction** — call sites use `getPrompt()` from
  `src/application/bootstrap/get-shared-deps.ts`. Application-side type re-export at
  `src/application/ui/prompt-port.ts`. `InkPromptAdapter` (`src/integration/ui/prompts/`) is the single
  implementation. When a prompt fires and the full dashboard isn't mounted, the adapter auto-mounts a minimal Ink
  tree containing only `<PromptHost />`. Non-interactive environments throw `PromptCancelledError`.
- **LoggerPort is the only logging abstraction** — three sinks: `PlainTextSink` (TTY one-shot CLI), `JsonLogger`
  (non-TTY / piped / CI), `InkSink` (Ink-mounted, publishes to a log event bus consumed by the dashboard). Plus a
  `JsonlSink` that fans every log entry to `<dataRoot>/logs/<sessionId>.jsonl` for post-hoc debugging — wired via
  `FanOutLogger` so console + on-disk receive identical streams.
- **SignalBusPort is the live observability stream** — `ExecuteSingleTaskUseCase` (and the per-task chain it sits in)
  emit on every parsed signal, rate-limit pause/resume, and task lifecycle event. Dashboard subscribes to render
  live; filesystem signal handler subscribes to persist. `InMemorySignalBus` micro-batches emissions at ~16ms.
- **Skills lifecycle** — default skills sync to `<dataRoot>/cache/skills/` and link from sprint working directories
  via `link-skills` / `unlink-skills` leaves. `executeFlow` and `refineFlow` bracket their AI sessions with the pair
  — execute does code editing, refine produces structured requirement artefacts where skills like "good-requirements"
  shape output quality. Plan / ideate / onboard skip the bracket — they read code or do environment detection where
  bundled skills add nothing. Adapter lives in `src/integration/ai/skills/`.
- **No barrel files** — every import points to the source module directly. Never add an `index.ts` that only
  re-exports from siblings; tree-shaking and import clarity beat brevity at the call site.
- **Repo onboarding** — `ralphctl project onboard <project> [--repo] [--dry-run] [--auto]` runs the
  `createOnboardFlow` chain (`src/application/chains/onboard/onboard-flow.ts`). Step trace:
  `load-project → resolve-repo → run-onboard-ai → confirm-setup-script → confirm-verify-script → confirm-context-file
→ write-context-file → save-repo-scripts`. A single AI session emits four artefacts via signals
  (`<setup-script>`, `<verify-script>`, `<agents-md>`, `<skill-suggestions>`); the user reviews each independently.
  Writes the provider-native project context file the active `config.aiProvider` natively reads: `CLAUDE.md` at repo
  root for Claude, `.github/copilot-instructions.md` for Copilot. No symlinks, no pointer files. Mode auto-detected:
  `bootstrap` (no prior file), `adopt` (file present, no harness marker — preserve prose), `update` (harness marker
  `<!-- ralphctl onboard: <ISO> -->` present — prune + augment). Persists `setupScript` + `checkScript` +
  `onboardedAt` (IsoTimestamp) on the `Repository` entity via `markOnboarded`.
- **Create-PR / MR chain** — `ralphctl sprint create-pr` runs `createCreatePrFlow`
  (`src/application/chains/create-pr/create-pr-flow.ts`). Step trace:
  `load-sprint → assert-has-branch → derive-pr-content → create-pull-request → record-pr-url`. Detects `gh` vs `glab`
  from the git remote. Persists `pullRequestUrl` on the `Sprint` entity. The pipeline-map's Close phase prefers
  Create PR over Close Sprint when the sprint is active, all tasks done, has a branch, and no PR yet.
- **Persistent banner + help modal** — `<Banner />` renders on every view via `<ViewShell />`, with the quote
  stabilised at module load (`STABLE_QUOTE` in `src/application/tui/components/banner.tsx`) so navigation doesn't
  jitter. `?` opens `<HelpOverlay />` as a modal — the router renders only the overlay when `isHelpOpen`, suspending
  the view tree, prompts, hints, and status bar. Esc / `?` closes.
- **Centralised keyboard map** — every shortcut lives in `src/application/tui/keyboard-map.ts`. The help overlay
  generates its rows from the same table; adding a binding is a single edit. Areas: `global / home / list / detail /
execute / attach / runs / settings / help / notification`.
- **Prompt transcript** — resolved prompts render dim above the live prompt as a transcript so the user sees the
  values they've already entered. History clears when the queue idles past `SEQUENCE_IDLE_MS = 100ms`
  (`src/integration/ui/prompts/prompt-queue.ts`). Per-kind value renderers live in `prompt-transcript.tsx`.
- **Schema-driven settings panel** — rows iterate `CONFIG_ROWS` (`src/application/config/config-schema-rows.ts`);
  each row's prompt kind (`select` / `confirm` / `input`) is determined by value type. Edits save immediately via
  `ConfigStorePort.save()`.
- **Doctor view** — `<DoctorView />` runs `runDoctor()` on mount; renders per-check status rows + an aggregate
  `ResultCard`. `!` opens it from anywhere. Checks live in `src/application/doctor/checks/`, including
  `onboarding-status.ts` which reports per-(project, repo) onboarding state.
- **Mark-blocked task status** — `Task.markBlocked(reason)` / `Task.unblock()` add `'blocked'` to the
  `TaskStatus` union (todo / in_progress / done / blocked). Branch-preflight failures fall back to `markBlocked`
  via `OnError` rather than aborting the chain.

## Common Mistakes to Avoid

- Don't reference or create a `sprint activate` command — use `sprint start`
- Don't confuse `currentSprint` (which sprint CLI targets) with `sprintStatus` (draft/active/closed)
- Don't store repository names in `affectedRepositories` — store absolute paths
- Don't explore repos during `sprint refine` — refinement is implementation-agnostic (WHAT, not HOW)
- Don't break task `blockedBy` dependencies during planning — preserve dependency chains
- Don't let prompt templates drift from command implementation — verify prompts describe actual workflow
- Don't hardcode provider-specific logic outside `src/integration/ai/providers/` — use the provider abstraction
- Don't assume both providers share the same permission model — Claude uses settings files, Copilot uses
  `--allow-all-tools` (see Provider Differences below)
- Don't add runtime auto-detection of check scripts — it's for `project add` suggestions only
- Don't introduce symlinks or pointer files for provider-facing artefacts — `project onboard` writes the native file
  based on `config.aiProvider`
- Don't skip file locks for data mutations — `FileLocker` (`src/integration/persistence/file-locker.ts`) prevents
  race conditions in concurrent access (30s default timeout, configurable via `RALPHCTL_LOCK_TIMEOUT_MS`)
- Don't add `index.ts` barrel files — every import goes directly to its source module
- Don't import `@inquirer/prompts` — use `getPrompt()` from `src/application/bootstrap/get-shared-deps.ts`
- Don't call use cases from CLI commands or TUI views — ESLint fence blocks it. Use chain factories from
  `src/application/chains/<workflow>/` and launch via `SessionManager.start(...)`.
- Don't invent a `Conditional` chain element — branching belongs inside a use case or in a sub-chain the caller
  selects. The kernel framework has six concepts only: `Element`, `Leaf`, `Sequential`, `Parallel`, `Retry`, `OnError`.
- Don't import from `typescript-result` directly — use `import { Result } from '<path>/domain/result.ts'`
- Don't put repository interfaces in `business/ports/` — they live in `domain/repositories/` (one per aggregate root)

## Workflow

```
0. Check setup        → ralphctl doctor (environment health check)
1. Add projects       → ralphctl project add
   (optional)          ralphctl project onboard <name> (AI-assisted setup scripts + project context file)
2. Create sprint      → ralphctl sprint create --project <name> (draft, becomes current)
3. Add tickets        → ralphctl ticket add
4. Refine requirements → ralphctl sprint refine (WHAT — clarify requirements)
5. Plan tasks         → ralphctl sprint plan (HOW — explore repos, generate tasks)
6. Start work         → ralphctl sprint start (auto-activates draft sprints)
7. Inspect            → ralphctl sprint progress (timeline + blockers + stale + cycles + branch)
8. Publish            → ralphctl sprint create-pr (open PR / MR from sprint branch)
9. Close sprint       → ralphctl sprint close
```

**Optional:** Configure your preferred AI provider with `ralphctl config set provider <claude|copilot>` (prompted on
first use if not set). Install shell tab-completion with `ralphctl completion install [--shell bash|zsh|fish]`.

### Command Surface

| Group      | Subcommands                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------- |
| top-level  | `doctor`, `interactive`, `completion install`, `completion show`                                  |
| `config`   | `show`, `set`                                                                                     |
| `project`  | `add`, `list`, `show`, `remove`, `repo add`, `repo remove`, `onboard`                             |
| `sprint`   | `create`, `edit`, `set-current`, `activate`, `list`, `show`, `remove`, `close`, `refine`, `plan`, |
|            | `ideate`, `start`, `feedback`, `create-pr`, `progress`, `requirements`, `context`                 |
| `ticket`   | `add`, `edit`, `approve`, `remove`                                                                |
| `task`     | `add`, `list`, `show`, `edit`, `edit-status`, `remove`                                            |
| `sessions` | `list`, `attach`, `detach`, `kill` — multi-chain runtime registry                                 |

### Provider Configuration

```bash
ralphctl config set provider claude      # Use Claude Code CLI
ralphctl config set provider copilot     # Use GitHub Copilot CLI
```

Auto-prompts on first AI command if not set. Both CLIs must be in PATH and authenticated.

### Provider Differences

| Aspect              | Claude Code                                                                                      | GitHub Copilot      |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| CLI flags           | `--permission-mode bypassPermissions` (headless) / `acceptEdits` (interactive), `--effort xhigh` | `--allow-all-tools` |
| Settings files      | `.claude/settings.local.json`, `~/.claude/settings.json`                                         | None                |
| Allow/deny patterns | `Bash(git commit:*)`, `Bash(*)`, etc.                                                            | Not applicable      |

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

- Per-ticket HITL clarification: AI asks questions, user approves requirements
- **Implementation-agnostic** — no code exploration, no repo selection
- Stores results as `requirementStatus: 'approved'` on each ticket

**Phase 2: Task Generation** (`sprint plan`) — HOW to implement

- Requires all tickets to have `requirementStatus: 'approved'`
- Repo selection runs inside the chain (`persist-repo-selection` leaf) → saved to `sprint.affectedRepositories`
- AI explores confirmed repos only → generates tasks split by repo with dependencies
- Repo selection persists for resumability

### Draft Re-Plan

Running `sprint plan` on a draft sprint that already has tasks triggers re-plan mode:

- Processes ALL tickets (not just unplanned ones)
- Existing tasks are included as AI context so the model can reuse, modify, or drop them
- AI generates a complete replacement task set covering all tickets
- New tasks atomically replace all existing tasks (interruption-safe)
- Dependency reorder runs after every import
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

**Conditional sections** — `{{VARIABLE}}` placeholders in prompts can be empty strings; avoid numbered lists that
create gaps (use blockquotes or bullets)
**Em-dash usage** — Use `—` (em-dash) not `-` (hyphen) for explanatory clauses in `.md` prompts (consistency across all
prompt files)
**Workflow sync** — Prompt templates must match actual command flow (e.g., repo selection happens in command before
the AI session starts)
**Template builders** — `src/integration/ai/prompts/template-loader.ts` loads `.md` templates;
`placeholder-substitution.ts` performs the substitution; `prompt-builder-adapter.ts` is the `PromptBuilderPort` impl
**No hardcoded package-manager commands** — prompts must not embed `pnpm`/`npm`/`pip`/`cargo`/`go test` outside the
`{{PROJECT_TOOLING}}` or `{{CHECK_GATE_EXAMPLE}}` placeholders. Downstream ecosystems differ; the placeholders are the
seam.
**Conditional placeholders must not sit inside numbered lists** — when the substitution is empty the list must still
read cleanly. Emit conditional content as a standalone bullet or paragraph.
**Downstream `.claude/` is optional context** — many downstream repos have no `.claude/` directory. Reference it as
"when present" rather than prescriptively; skip silently when absent.
**Absolute rules name their exception** — `never`/`always` phrasing is fragile when legitimate exceptions exist. Name
the exception inline.

## UI Patterns

**Two UI surfaces — pick the right one for the command:**

- **Ink TUI** (`src/application/tui/`) — live dashboard, REPL, settings panel, sessions switcher, inline editor,
  doctor view, browse/CRUD views. Mounted by bare `ralphctl`, `ralphctl interactive`, and `ralphctl sprint start`.
  Takes over the terminal via the alt-screen buffer (like vim/htop) and restores on exit. Uses `@inkjs/ui` components
  - the `LoggerPort` event bus for live-updating output. The Banner is persistent across every view (stable per-process
    quote); Home additionally renders the `<PipelineMap />` (Refine / Plan / Execute / Close 4-row spine + bright
    "Next step" quick-action) and a tiered browse submenu (`b` from Home → Sprint / Ticket / Task / Project drill-ins).
    Multi-chain navigation: Tab / Shift+Tab cycle sessions, `Ctrl+1..9` direct-jump. `?` opens the help modal.
- **Plain-text CLI** — one-shot commands (`sprint show`, `config set`, `project add`, etc.) use `PlainTextSink` for
  structured logging plus the pure formatters in `src/integration/ui/theme/ui.ts`. When a prompt fires, the
  `InkPromptAdapter` auto-mounts a minimal `<PromptHost />` inline. Resolved prompts render dim above the active
  prompt as a transcript and clear after a 100 ms idle.

Never add raw emoji or inconsistent formatting — use theme tokens from `src/integration/ui/theme/theme.ts` and
the formatters from `src/integration/ui/theme/ui.ts`. Ink components pull theme tokens via
`src/integration/ui/theme/tokens.ts`.

**The Ink TUI has a design system** — see [`.claude/docs/DESIGN-SYSTEM.md`](.claude/docs/DESIGN-SYSTEM.md) before
adding a view, component, or glyph. It covers tokens, component inventory, state surfaces, navigation contract, copy
rules, and anti-patterns. Most needs are already solved — reuse `ViewShell` + `ResultCard` + `FieldList` + `Spinner`
before inventing.

## Task Execution Signals

See `ARCHITECTURE.md § Harness Signals` and `src/domain/signals/harness-signal.ts`. Adding a variant to the
`HarnessSignal` discriminated union triggers compiler exhaustiveness errors at every consumer via
`const _exhaustive: never = signal`. Signals flow to two subscribers in parallel: `FileSystemSignalHandler`
(`integration/signals/file-system-handler.ts`, durable) + `SignalBusPort` (live dashboard).

## Feedback Loop

Optional, opt-out, runs only after all tasks complete successfully. The feedback flow is its OWN chain
(`src/application/chains/feedback/feedback-flow.ts`), not embedded inside `executeFlow`:

- Once `executeFlow` settles, the CLI/TUI checks outcomes and starts a `createFeedbackFlow` session if the user
  provides input
- User types free-form feedback; empty input exits the loop immediately
- AI implements the feedback, check scripts re-run, evaluator re-runs (one round per chain run = one feedback iteration)
- No hard iteration cap — empty submission is the natural terminator, owned by the launching CLI/TUI
- Disable per-run with `--no-feedback`; disabled implicitly in `--session` mode

## Parallel Execution

`sprint start` runs tasks in parallel by default — the `executeFlow` uses a `kernel/chain` `Parallel` element with
default concurrency 4 and `failureMode: 'collect-all'` so one failing task doesn't abort the others:

- Session/step mode forces sequential (`--concurrency 1` equivalent)
- **Rate limiting:** `RateLimitCoordinator` (`src/kernel/algorithms/`) pauses new task launches when any task hits
  a rate limit; running tasks continue uninterrupted. `ExecuteSingleTaskUseCase` calls `coordinator.pause(reason)`
  on a 429 hint; the per-task chain's `wait-for-rate-limit` leaf awaits `coordinator.waitUntilResumed()` before
  launching the AI session, and `execute-task` is wrapped in `Retry(maxAttempts: 2, retryOn: code === 'rate-limited')`
  for the in-task retry. The coordinator's pause / resume events bridge to `SignalBusPort` so the dashboard's
  `RateLimitBanner` reacts uniformly whether the pause came from the spawn-loop or the chain layer.
- Errors with rate-limit headers (429-style responses) trigger coordinator pause automatically

## Environment Variables

| Variable                    | Default        | Range                         | Purpose                                                                       |
| --------------------------- | -------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `RALPHCTL_ROOT`             | `~/.ralphctl/` | Any valid path                | Override data directory (e.g., for testing or multi-workspace setup)          |
| `RALPHCTL_SETUP_TIMEOUT_MS` | 300000 (5 min) | > 0                           | Timeout for check scripts; overridable per-repo via `Repository.checkTimeout` |
| `RALPHCTL_LOCK_TIMEOUT_MS`  | 30000          | 1–3600000                     | Stale lock file threshold for concurrent access detection                     |
| `RALPHCTL_LOG_LEVEL`        | `info`         | `debug`/`info`/`warn`/`error` | Filter structured-log output (PlainTextSink and JsonLogger)                   |
| `RALPHCTL_NO_TUI`           | unset          | any truthy value              | Force the plain-text CLI fallback even on a TTY (skip Ink mount)              |
| `RALPHCTL_JSON`             | unset          | any truthy value              | Force the `JsonLogger` sink (one JSON object per line) regardless of TTY      |
| `NO_COLOR`                  | unset          | any truthy value              | Suppress ANSI colors                                                          |
| `CI`                        | unset          | any truthy value              | Auto-detected; disables Ink mount and implicit interactive prompts            |
| `VISUAL` / `EDITOR`         | unset          | editor command                | Read by the editor resolver; the Ink inline editor is preferred on TTY        |

**Note:** In tests, set `RALPHCTL_ROOT` BEFORE importing persistence modules (e.g., in setup file before `describe`
blocks).

## Build & Distribution

Prompt templates and default skills are distributed with the CLI. The build script copies `.md` templates and the
bundled skill set from `src/integration/ai/` into `dist/`. Template loading is dual-mode:

- **Dev:** Reads from `src/integration/ai/prompts/templates/*.md`
- **Bundled (npm):** Reads from `dist/prompts/*.md`

**Gotcha:** If `.md` files are missing in `dist`, templates silently fail with empty placeholder values (no
file-not-found error). CI verifies dist works by testing `node dist/cli.mjs --version` from arbitrary cwd.

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
