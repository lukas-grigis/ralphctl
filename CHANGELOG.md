# Changelog

All notable changes to RalphCTL will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Source tree restructure — one home per concept.** Collapsed `src/business/pipeline/` (singular) into
  `src/business/pipelines/framework/` so there's no more pipeline-vs-pipelines confusion. Moved
  `src/domain/repositories/` into `src/business/ports/` — every interface business logic depends on now lives in
  one folder. Carved `src/integration/ai/`'s 20-file dump into `session/`, `output/`, `prompts/`, `providers/`
  with three leaf files. Unified all interactive-prompt UI under `src/integration/ui/prompts/` (was a separate
  top-level `prompts/`) and merged the split `ui/theme/` + `ui/tui/theme/` directories. Drained
  `src/integration/utils/` to its logical homes (`ids` → domain, `exit-codes` → application,
  `detect-scripts` → external). Hoisted one-file directories (`filesystem/`, `user-interaction/`) into flat
  adapter files. Dead `multiline.ts` deleted. `lifecycle.ts` (shell-exec for checkScripts) moved out of
  `ai/` and into `external/` where it actually belongs.
- **Sequence diagrams split per pipeline.** Replaced the 260-line monolith `seq.puml` with
  `seq-refine.puml`, `seq-plan.puml`, `seq-ideate.puml`, `seq-evaluate.puml`, and `seq-execute.puml` — each
  1:1 with a pipeline definition under `src/business/pipelines/`. Retired the aspirational `target-seq.puml`
  (most TODOs shipped; remainder tracked in `ARCHITECTURE.md` "Future Work"). Retired the stale
  `next-session-plan.md` handoff.
- **Docs synced to the new shape.** `CLAUDE.md`, `ARCHITECTURE.md`, and `REQUIREMENTS.md` now match the
  restructured tree. `ARCHITECTURE.md` step-order table links to the per-pipeline diagrams and lists the
  `contract-negotiate` step it was missing.

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
