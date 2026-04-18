# Changelog

All notable changes to RalphCTL will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-04-18

### Added

- **Inline requirements preview** in `sprint refine` — the refined requirements are now shown as a bordered
  quote-rail block above the approval prompt so the user reviews the actual content before approving.
- **Live execute log** — the bottom log tail in `sprint start` renders the active spinner with live braille
  frames instead of a static glyph; resolved spinners collapse to a check/cross.
- **Auto-refreshing dashboard** — Home and Dashboard subscribe to the signal bus and reload data
  (throttled 500ms) during a running sprint, so task-started / task-finished / per-task signals tick the
  UI without a manual refresh.
- **Multi-line feedback editor** — the end-of-sprint feedback loop now uses the Claude-style inline editor
  (markdown, Ctrl+D submits, Esc cancels) instead of single-line input.
- **Task-like feedback iterations** — each feedback round now runs as a synthetic `Task` per affected repo:
  emits `task-started` / `task-finished` to the signal bus, routes parsed progress / note / blocked signals
  to the durable signal handler, and gates through the same post-task check script used for real tasks.
  The live dashboard animates feedback work the same way it animates regular tasks.
- **`truncate()` domain utility** (`src/domain/strings.ts`) — unifies the five hand-rolled clipping sites and
  fixes the `…` vs `...` inconsistency.

### Changed

- **Task-sizing prompt** — rewrote to emphasize coherence over line count. Explicit "do not split" /
  "do split" lists, a soft ~10-files / ~500-lines ceiling, and a task-count directive that lets scope drive
  the number rather than targeting 5–15.
- **Evaluator-resume prompt** — adds a "pivot when the critique is structural" clause so the resumer can
  replace a wrong approach instead of repeatedly patching it on related grounds. Default remains minimal fix.

### Fixed

- Suppressed the spurious "Reached maximum feedback iterations" warning that fired on clean empty-feedback
  exit.
- Hoisted `getTasks()` + repo-path resolution out of the feedback loop (was N+1 across iterations).
- Memoized the `resolvedIds` Set in `LogTail` — previously rebuilt from the full events array on every
  ~16ms render during execution.
- Shortened the over-long rejected-requirements warning in `sprint refine`.
- Dropped the fragile content-hash React key in `ConfirmPrompt`'s details block.

## [0.3.0] - 2026-04-17

### Housekeeping

- Pruned dead code across the theme, prompts, runtime, and factories layers: deleted unused formatters
  (`showInfo`, `printSummary`, `formatMuted`, `renderColumns`, `renderProgressSummary`), theme shortcuts
  (`warning`/`info`/`highlight`/`accent`/`primary`/`secondary`/`subtle` top-level re-exports and
  `colors.primary`/`colors.secondary`/`colors.subtle`), the never-wired `useLiveConfig` hook, the
  `PullQuote` component, the intermediate `editor.ts` wrapper, and the unused use-case + pipeline
  factory re-exports (`createRefineUseCase`, `createPlanUseCase`, `createIdeateUseCase`,
  `createEvaluateUseCase`, `createEvaluatorPipeline`, `createPerTaskPipeline`). `factories.ts` now
  exports only the four pipeline factories CLI and TUI actually call.
- Renamed `spawnHeadlessRaw` → `spawnHeadless` — the `Raw` suffix was vestigial after its wrapper was
  deleted.
- Added `FilesystemPort.getIdeationDir(sprintId, ticketId)` + the matching `paths.ts` helper; fixed a
  forgotten migration where `plan.ts` hardcoded the ideation directory path.
- Tightened the export surface — made ~55 prompt/view prop and option types private to their modules.
- Removed error classes that had no remaining call sites: `NotFoundError`, `TaskStatusError`,
  `ProviderError`.

### ⚠ BREAKING

- **Sprints are now scoped to a single project.** Sprint carries a `projectId`; tickets and tasks inherit
  project context. All cross-entity references use IDs instead of slug names. Old sprints missing
  `projectId` need a manual migration — there is no compatibility shim in this release. Rationale: the
  previous slug-based coupling silently broke when project names changed, and cross-project sprints were
  never a supported workflow in practice.

### Added

- **Composable pipelines.** Every user-triggered workflow (refine, plan, ideate, evaluate, execute) is now
  a composable `PipelineDefinition` under `src/business/pipelines/`. Framework primitives —
  `step` / `pipeline` / `nested` / `forEachTask` / `insertBefore` / `insertAfter` / `replace` / `renameStep` —
  live in `src/business/pipelines/framework/`; shared steps in `src/business/pipelines/steps/`. An ESLint
  fence blocks CLI / TUI from calling use cases directly.
- **Ink TUI.** Bare `ralphctl`, `ralphctl interactive`, and `ralphctl sprint start` mount a full-screen Ink
  application that takes over the terminal (alt-screen buffer, restored on exit). Includes: pipeline map
  Home, per-phase detail views, live execution dashboard, settings panel (`s`), global doctor hotkey (`?`),
  browse views for every entity with housekeeping CRUD, first-run onboarding wizard, npm version hint with
  24h cache, inline multi-line editor (Claude Code-style), sprint-show hub with per-sprint surfaces.
- **PromptPort + InkPromptAdapter.** One abstraction for every interactive prompt. Auto-mounts a minimal
  `<PromptHost />` for one-shot CLI commands; non-TTY environments throw `PromptCancelledError`.
- **LoggerPort with three sinks.** `PlainTextSink` (TTY one-shot CLI), `JsonLogger` (non-TTY / CI —
  one JSON object per line), `InkSink` (routes through the Ink event bus when mounted).
- **Structured harness signals.** Fixed discriminated union in `src/domain/signals.ts`
  (`ProgressSignal` / `EvaluationSignal` / `TaskCompleteSignal` / `TaskVerifiedSignal` / `TaskBlockedSignal` /
  `NoteSignal`). Adding a signal variant is a compile-time-enforced code change. `InMemorySignalBus`
  micro-batches emissions at ~16ms so the dashboard re-render stays smooth.
- **Config schema as single source of truth.** All keys defined in `src/domain/config-schema.ts` with type,
  default, description, and validation. `doctor`, `config show`, `config set`, and the Ink settings panel
  are all schema-driven — adding a key is a single edit.
- **Live config mid-execution (REQ-12).** `ExecuteTasksUseCase.getEvaluationConfig()` reads config fresh on
  every task settlement. Editing `evaluationIterations` in the settings panel during a run applies to the
  next task with no restart.
- **Per-task sprint contracts** written to `<sprintDir>/contracts/<taskId>.md` — a stable grading surface
  the evaluator references instead of re-deriving expectations from prompts.
- **Evaluator plateau detection** — short-circuits the eval loop when a critique stops improving between
  iterations.
- **Session-id resume across rate-limit pauses** — running task keeps its full context when the provider
  restarts.
- **Per-task evaluator dimensions** — four floor dimensions on every task (Correctness / Completeness /
  Safety / Consistency) plus planner-emitted `extraDimensions` for non-default success criteria
  (e.g. Performance, Accessibility).
- **Branch management.** `sprint start` prompts for branch strategy on first run; `--branch` auto-generates
  `ralphctl/<sprint-id>`; `--branch-name` for custom names; per-repo pre-flight verification;
  `sprint close --create-pr` opens PRs for sprint branches.
- **Management hotkeys on list + detail views** for tickets, tasks, sprints, and projects. Task-status
  hotkey renamed `s` → `t` to free `s` for the global settings panel.

### Changed

- **Clean Architecture.** Codebase now has four inward-pointing layers: `domain` (pure models,
  errors, signals) ← `business` (use cases + every port under `src/business/ports/`) ←
  `integration` (adapters, UI, 3rd-party glue) ← `application` (composition root). Every port has a single
  adapter under `src/integration/`. Use cases return `Result<T, DomainError>`; no throws at the boundary.
- **Claude provider defaults to `--effort xhigh`** for Opus 4.7 plans. Lower effort levels are mapped down
  for older models.
- **Prompts aligned with Opus 4.7's literal interpretation** — every template (`task-execution`,
  `task-evaluation`, `task-evaluation-resume`, `plan-auto`, `plan-interactive`, `ideate`, `ideate-auto`,
  `ticket-refine`, `sprint-feedback`) and the shared partials were rewritten to flip residual negatives
  and eliminate ambiguity. Check-script and Project Tooling context are now threaded into both the
  task-execution and evaluator prompts.
- **Evaluator model ladder** — pinned opus-4-7 → sonnet; documented the full ladder
  (Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku for Claude; Copilot spawns without model override).
- **Rate-limit coordinator** lives behind the `SharedDeps` factory so executor and evaluator share one
  coordinator. New task launches pause globally when any task hits a rate limit.
- **TUI design system.** All views compose through `ViewShell` + `useViewHints` — consistent spacing,
  borders, and hotkey hints. Hardcoded glyphs / spacing / colors swept out of components in favour of
  theme tokens.
- **Source tree restructure — one home per concept.** Collapsed `src/business/pipeline/` (singular) into
  `src/business/pipelines/framework/`. Moved `src/domain/repositories/` into `src/business/ports/` so
  every interface business logic depends on lives in one folder. Carved `src/integration/ai/`'s 20-file
  dump into `session/`, `output/`, `prompts/`, `providers/`. Unified all interactive-prompt UI under
  `src/integration/ui/prompts/`. Merged the split `ui/theme/` + `ui/tui/theme/` directories. Drained
  `src/integration/utils/` to its logical homes (`ids` → domain, `exit-codes` → application,
  `detect-scripts` → external). Hoisted one-file directories into flat adapter files. Deleted dead
  `multiline.ts`. Moved `lifecycle.ts` (shell-exec for checkScripts) from `ai/` to `external/`.
- **No barrel files.** Every import points to its source module directly.
- **Full-screen responsive TUI** — dropped the content-width cap.
- **Settings panel is the single configuration entry** — redundant `config set` TUI surface removed.

### Fixed

- `SelectPrompt` commits the highlighted row, not the stale default.
- Router hotkeys disable while a prompt is pending.
- Arrow keys cycle through every phase in the pipeline map.
- Spinner no longer leaks through prompts.
- Plan/ideate plain-text output no longer bleeds into the Ink alt-screen.
- Close-phase Enter pops back when the sprint is already closed.
- `useViewHints` infinite render loop broken.
- Banner pinned to router shell (stops stale-closure refine fallthrough); content column recentered;
  gradient + quote memoized per mount.
- `sprint-feedback` prompt rewritten so user feedback actually lands in the AI session.
- AI provider resolved lazily before sync getters.

### Removed

- Legacy `ai/executor` + runner (unreachable after the pipeline migration).
- `src/interactive/` (superseded by the Ink TUI); `ora` dependency; every direct `@inquirer/prompts`
  import (now routed through `PromptPort`).
- Pre-generated JSON schema mirrors under `schemas/` — regenerate on demand from Zod.
- Dead `parallelMap` pipeline primitive and the `__services` magic context key.

### Documentation

- **Sequence diagrams split per pipeline.** Replaced the 260-line monolith `seq.puml` with
  `seq-refine.puml`, `seq-plan.puml`, `seq-ideate.puml`, `seq-evaluate.puml`, and `seq-execute.puml` —
  each 1:1 with a pipeline definition under `src/business/pipelines/`.
- **CLAUDE.md / ARCHITECTURE.md / REQUIREMENTS.md** rewritten to match the new shape. The step-order
  table in `ARCHITECTURE.md` links to the per-pipeline diagrams and covers every pipeline step.

## [0.2.5] - 2026-04-09

### Changed

- **Prompt templates consolidated into shared partials** — `harness-context`, `signals-task|planning|evaluation`,
  `validation-checklist`, and `plan-common` live as standalone `.md` files and are composed into each template at
  build time. Eliminates literal duplication across all 7 prompt templates; adding new shared content is now a
  one-line change (#61)
- **Strict `composePrompt()` contract** — Builder throws synchronously on any unreplaced `{{TOKEN}}` instead of
  silently rendering empty placeholders. Closes the silent-failure class called out in `CLAUDE.md` about missing
  substitutions (#61)
- **Target-project tooling threaded into planner and ideate prompts** — `sprint plan` and `sprint ideate` now surface
  the downstream project's `.claude/agents/*.md`, `.claude/skills/`, `.mcp.json` servers, and instruction files with
  prescriptive delegation hints in generated task steps. Previously only the evaluator prompt (0.2.4) saw this.
  `implementer` and `planner` remain denylisted at detection time so the evaluator never delegates back to its own
  generator side (#61)
- **Prompt audit tests** — New per-template assertions enforce "prompts run in downstream projects — never hardcode
  ralphctl's own name or subagents" as test-as-documentation. Fails at CI time if a future template drifts (#61)

### Documentation

- **README refresh** — Surface branch-per-sprint workflow (`--branch`, `sprint close --create-pr`), the
  `sprint insights` command, and `evaluationIterations` tuning with the `--no-evaluate` single-run escape hatch —
  all shipped since the 0.2.2 README redesign but were never documented (#61)
- **ARCHITECTURE.md sync** — Drop phantom `Ticket.externalId` and `DuplicateTicketError`; add `Repository.checkTimeout`,
  `Task.verificationCriteria`, `Task.evaluationStatus`, `Task.evaluationFile`, the `evaluations/` sidecar directory,
  and the top-level `insights/` directory. Error-class table now reflects what's actually exported from
  `src/errors.ts` (#61)

## [0.2.4] - 2026-04-07

### Added

- **Sidecar critique persistence** — Full untruncated evaluator critique persisted to
  `<sprintDir>/evaluations/<taskId>.md`, one entry per iteration. `tasks.json` keeps a 2000-char preview in
  `evaluationOutput`, the file path in `evaluationFile`, and a status discriminator in `evaluationStatus`
  (`'passed' | 'failed' | 'malformed'`). Bail cases (no `<task-complete>`, generator no-op, recheck failure) append
  self-explanatory stub entries so the trail is readable without cross-referencing executor stdout (#60)
- **Project tooling detection** — Evaluator prompt now surfaces installed `.claude/agents/*.md`, `.claude/skills/`,
  `.mcp.json` servers, and instruction files (`CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md`) with
  prescriptive delegation hints (`auditor` for security-sensitive diffs, `reviewer` for code quality, Playwright MCP
  for UI tasks). `implementer` and `planner` are denylisted at detection time so the evaluator never delegates back
  to its own generator side (#60)
- **Malformed evaluator status** — New `'malformed'` discriminator distinguishes "evaluator output had no parseable
  signal" from a real failure. The fix loop now bails before feeding garbage to the generator as a "critique" (#60)

### Changed

- **Evaluator participates in parallel rate-limit coordinator** — Waits during global pauses and triggers them on its
  own 429s, so generator tasks back off when the evaluator hits the wall first instead of stampeding into the same
  wall (#60)
- **Evaluator capped at 100 turns** — Lower than executor's 200; review work doesn't need a runaway budget (#60)
- **Evaluator spawn failures no longer crash the sprint** — `runEvaluation` calls are wrapped in a safe helper that
  converts errors to malformed results, matching the "evaluator never permanently blocks" contract documented in
  CLAUDE.md (#60)
- **`evaluationIterations` semantics clarified** — Now documented as "number of fix attempts after the initial
  evaluation". Default `1` = 1 initial eval + up to 1 fix-and-reeval round = at most 2 evaluator spawns. `0` disables
  evaluation entirely (#60)
- **Resume prompt extracted to template file** — Inline 7-line generator-resume prompt moved from `executor.ts` to
  `src/ai/prompts/task-evaluation-resume.md` so it can be reviewed alongside the other prompt templates (#60)

### Fixed

- **Sequential post-task check ignored per-repo `checkTimeout`** — Now correctly threaded into both `runLifecycleHook`
  and the evaluation loop's recheck. Parallel mode was already correct; only the sequential path was affected (#60)
- **No-op generator fix attempts now break the loop** — After a generator resume, the executor compares HEAD SHA and
  working-tree state; if neither changed, it bails instead of burning another evaluator spawn on the same critique
  (#60)

## [0.2.3] - 2026-04-06

### Added

- **Verification criteria** — new `verificationCriteria` field on Task schema, surfaced in task context and evaluator
  prompt as the grading contract; JSON schemas (`tasks.schema.json`, `task-import.schema.json`) updated with sync tests
  (#57)
- **Evaluator dimension scoring** — structured PASS/FAIL parsing per dimension (correctness, completeness, safety,
  consistency) with per-dimension findings (#57)
- **Sprint insights** — new `sprint insights` command to analyze evaluation results and surface patterns across tasks
  (#57)

### Changed

- **Executor hardening** — `--max-turns` safety net (default 200), session ID tracking across evaluation iterations,
  correct model propagation on fix attempts (#57)
- **Prompt quality** — all 7 prompt templates rewritten per Anthropic's current best practices: toned down urgency
  language, added "why" explanations, XML structural tags, harness context (#57)
- **Documentation** — CLAUDE.md gains environment variables, build/distribution, and release sections; README adds
  reference links to Anthropic harness design articles
- Deduplicated console capture into shared `captureOutput` test helper

### Fixed

- Path traversal protection on ticket ID segments (#57)

### Dependencies

- Bumped `@types/node` from 25.5.0 to 25.5.2
- Bumped `@vitest/coverage-v8` from 4.1.1 to 4.1.2
- Bumped `eslint` from 10.1.0 to 10.2.0
- Bumped `typescript-eslint` from 8.57.2 to 8.58.0
- Bumped `vitest` from 4.1.1 to 4.1.2

## [0.2.2] - 2026-04-02

### Changed

- Redesigned README — new "Why ralphctl?" section, workflow diagram, features reframed as user benefits, collapsed CLI
  reference and provider comparison tables
- Improved 7 AI prompt templates — fixed `__tests__` rendering bug, added evaluator pass-bar guidance, clarified harness
  check behavior, added blocker handling to ideate-auto, softened prescriptive acceptance criteria wording
- Enhanced evaluation resume prompt with structured iteration steps and scope boundaries (aligned with Anthropic harness
  design patterns)

### Fixed

- Incorrect `dashboard` command reference in README (actual CLI command is `status`)
- Stale test comment claiming `.replace()` when code uses `.replaceAll()`; strengthened token replacement assertion

## [0.2.1] - 2026-04-01

### Fixed

- Evaluation resume prompt now instructs the generator to commit fixes, ensuring re-evaluation can see changes via
  `git diff`; respects `--no-commit` flag

## [0.2.0] - 2026-03-31

### Added

- **Generator-evaluator pattern** — autonomous code review after task completion with model ladder
  (Opus->Sonnet, Sonnet->Haiku, Haiku->Haiku); configurable `evaluationIterations`; `--no-evaluate` flag (#49)
- **Sprint ideation** — `sprint ideate` combines refine + plan in one session for quick ideas; auto-assigns ticketId;
  handles bare tasks array output (#51)
- **Budget and model controls** — `--max-budget-usd` and `--fallback-model` flags for `sprint start`
- **Per-repo check timeout** — configurable check script timeout per repository with failure isolation
- **Interactive config menu** — editor and evaluation iterations configurable from interactive mode

### Changed

- Rebranded from task management CLI to agent harness — updated description, README, and all documentation (#50)
- Achieved Copilot CLI parity with Claude Code provider (JSON output, session management, headless args) (#47)
- Provider-agnostic prompt templates and session routing through adapters
- Improved model name validation and provider handling security

### Fixed

- Stale sprint overwrite in ideation flow
- Hardened output parser for ideation and planning
- Provider spawn environment passed to all task execution paths
- `PROGRESS_FILE` placeholder replacement in task execution prompt
- MaxListeners leak in ProcessManager
- Replaced bare Error throws with domain errors
- Copilot permission check for settings file detection

### Tests

- Comprehensive evaluator tests
- Store layer tests (sprint, config, project)
- Parser and executor unit tests
- Permissions and prompt template tests

### Dependencies

- Updated in-range dependencies
- Added coverage tooling

## [0.1.4] - 2026-03-23

### Changed

- Opted into Node.js 24 for GitHub Actions runners (CI and release workflows)

### Dependencies

- Bumped `@inquirer/prompts` from 8.3.0 to 8.3.2
- Bumped `eslint` from 10.0.3 to 10.1.0
- Bumped `typescript-eslint` from 8.57.0 to 8.57.1
- Bumped dev dependencies (4 updates)

## [0.1.3] - 2026-03-14

### Changed

- Extracted `ensureError()` helper to eliminate duplicated inline error mapper pattern across 39 files (#44)
- Replaced `Result.try()` wrappers around `assertSprintStatus` with direct try/catch for clearer error handling (#44)
- `project.ts` now throws `ValidationError` (instead of generic `Error`) for path validation failures — errors display
  cleanly without stack traces (#44)
- Added unit tests for `result-helpers` (`wrapAsync`, `zodParse`, `unwrapOrThrow`, `ensureError`) (#44)
- Documented Result/throwing boundary convention in CLAUDE.md (#44)

## [0.1.2] - 2026-03-07

### Fixed

- Fixed tilde (`~`) path expansion — `~/repos/myproject` now resolves correctly in all project and task commands (#40)
- Added `expandTilde()` helper used consistently at write time across `createProject`, `updateProject`,
  `addProjectRepo`, `removeProjectRepo`, and all CLI path inputs
- Added one-time read-time migration to correct any previously stored tilde paths
- Added unit tests for `expandTilde()` and doctor tilde path validation

## [0.1.1] - 2026-03-07

### Fixed

- Fixed `npm install -g ralphctl` — CLI now works when installed globally via npm
- Fixed npm bin entry warning ("script name was invalid and removed")

### Changed

- Added tsup build step to compile TypeScript and resolve `@src/*` path aliases for distribution
- Moved `tsx` back to devDependencies (no longer needed at runtime for npm installs)
- Removed `.npmignore` (redundant with `files` allowlist in package.json)
- Cleaned up `.gitignore` (removed unused template entries for Next.js, Playwright, Storybook, CDK, etc.)
- CI pipeline now validates build output and runs npm install smoke test
- Release pipeline includes build step and tag/version consistency check before npm publish
- npm publish now includes `--provenance` for supply chain security

## [0.1.0] - 2026-03-07

### Added

- **npm publishing** — `ralphctl` package name reserved on npm
- Release pipeline for automated npm publish and GitHub Release creation
- `.npmignore` and `files` configuration for clean package contents

### Changed

- Streamlined README for end-user onboarding
- Added release process documentation to CONTRIBUTING.md

## [0.0.3] - 2026-03-06

### Changed

- Normalized git author identity across commit history
- Updated package metadata for open-source release (description, homepage, private flag)
- Moved `tsx` from devDependencies to dependencies (runtime requirement for `bin/ralphctl`)
- Fixed stale path references in SECURITY.md, CONTRIBUTING.md, and agent memory files
- Fixed changelog compare link in release workflow to include `v` prefix
- Corrected documentation table descriptions in README.md
- Cleaned up stale `dist/` build artifacts
- Edited documentation for public release

## [0.0.2] - 2026-03-03

### Added

- **Doctor command** — `ralphctl doctor` checks Node.js version, git, AI provider binary, data directory, project repos,
  and current sprint health
- **Shell tab-completion** — `ralphctl completion install` for bash, zsh, and fish via tabtab
- **Branch management** — `sprint start` prompts for branch strategy (keep current, auto, custom); `--branch` and
  `--branch-name` flags; pre-flight verification; `sprint close --create-pr` creates PRs
- **Provider abstraction** — `config set provider claude|copilot` with adapter layer; experimental Copilot CLI support
  with headless execution and session ID capture
- **Draft re-plan** — running `sprint plan` on a draft with existing tasks passes all tickets + tasks as AI context for
  atomic replacement
- **Check script model** — single idempotent `checkScript` per repo replaces old `setupScript`/`verifyScript`; runs at
  sprint start and as a post-task gate
- **Lifecycle hooks** — `runLifecycleHook()` abstraction in `src/ai/lifecycle.ts` with `RALPHCTL_LIFECYCLE_EVENT` env
  var
- **Ecosystem detection** — `EcosystemDetector[]` registry (node, python, go, rust, gradle, maven, makefile) for check
  script suggestions during project setup
- **Sprint health** — duplicate task order and pending requirements diagnostics; branch consistency checks across repos
- **Interactive mode** — Escape key navigation, styled section titles, flat workflow section, provider config in REPL,
  refined/planned counts in status header, guards for unrefined/unplanned tickets
- **Inline multiline editor** — replaced with `@inquirer/editor` and configurable editor settings via
  `config set editor`
- **CI/CD** — GitHub Actions pipeline with lint, typecheck, test, format check; Dependabot; automated GitHub Release
  pipeline
- **Schema sync tests** — JSON schema ↔ Zod schema validation

### Changed

- Renamed `claude` module to `ai` for provider-agnostic naming
- Replaced tsup build with bash wrapper approach for CLI outside repo root
- Default data directory changed to `~/.ralphctl` (was `ralphctl-data/`)
- Separated repo root from data directory with smart `RALPHCTL_ROOT` handling
- Removed `externalId` field and `--id`/`--editor` CLI flags from ticket command
- Documentation restructured — moved to `.claude/docs/`, slimmed CLAUDE.md from 613 to 160 lines with skill-based
  reference material
- Replaced raw color functions with theme helpers across all commands
- Improved card rendering and terminal width awareness

### Fixed

- Sanitize session IDs and harden file operations against path traversal
- Fixed pre-flight execution checks for security and correctness
- Preserve error cause in re-thrown errors
- Thread provider through `checkTaskPermissions()`
- Branch management error handling and retry logic
- Interactive mode duplicate quote, closed sprint status header, and dashboard duplication
- ANSI code handling in CLI test field extraction
- Removed redundant file reads in interactive menu context loading

### Dependencies

- Bumped `zod` from 3.x to 4.x
- Bumped `@inquirer/prompts` from 7.x to 8.x
- Bumped `@types/node`, `globals`, `ora`, `typescript-eslint`, and other dev dependencies

## [0.0.1] - 2026-02-15

### Added

- **Project management** — register multi-repo projects with named paths
- **Sprint lifecycle** — create, activate, close sprints with state machine enforcement (draft -> active -> closed)
- **Ticket tracking** — add work items linked to projects, with optional external IDs
- **Two-phase planning** — refine requirements (WHAT) then generate tasks (HOW) with human approval gates
- **Task dependencies** — `blockedBy` references with topological sort and cycle detection
- **Task execution** — headless, watch, session, and interactive modes via Claude CLI
- **Parallel execution** — one task per repo concurrently, with rate limit backoff and session resume
- **Interactive menu mode** — context-aware REPL with persistent status header and Quick Start wizard
- **Sprint health checks** — diagnose blockers, stale tasks, and missing dependencies
- **Requirements export** — markdown export of refined requirements
- **Progress logging** — append-only timestamped progress log per sprint
- **Ralph Wiggum personality** — themed UI with donut spinners, random quotes, and gradient banner
