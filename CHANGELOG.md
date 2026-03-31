# Changelog

All notable changes to RalphCTL will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

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
