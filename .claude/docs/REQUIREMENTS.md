# RalphCTL — Acceptance Criteria

Testable acceptance criteria for v0.7.0. Read on demand — this file is not auto-imported into every Claude
session. Source of truth for narrative constraints lives elsewhere; pointers below.

| For…                              | Read…                                  |
| --------------------------------- | -------------------------------------- |
| Architectural constraints         | [CLAUDE.md](../../CLAUDE.md)           |
| Module layout, data models, ports | [ARCHITECTURE.md](./ARCHITECTURE.md)   |
| Chain framework primitives        | [KERNEL-DESIGN.md](./KERNEL-DESIGN.md) |
| TUI design tokens / components    | [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) |

This document is the testable, checkbox-shaped fence. When work lands that ticks one of these criteria, mark
it done; when a behaviour regresses, untick it.

## Foundations

- [ ] **Clean Architecture layering** — see [CLAUDE.md § Architecture Constraints](../../CLAUDE.md). Acceptance:
      ESLint `no-restricted-imports` passes, `pnpm typecheck` is green.
- [ ] **No `class` outside `src/domain/value/error/`** — ESLint asserts.
- [ ] **No barrel files anywhere under `src/`** — `export *` blocked by ESLint.
- [ ] **Sibling-isolation rules** — each per-tool / per-variant adapter directory under
      `integration/ai/<concept>/` is independent; cross-sibling access goes through `_engine/`. Same applies to
      `business/<module>/` and `application/flows/<flow>/`.
- [ ] **Chain framework primitives** — see [KERNEL-DESIGN.md](./KERNEL-DESIGN.md). Acceptance: every primitive
      (`leaf` / `sequential` / `loop` / `guard`) has unit tests in isolation; every flow definition has a
      step-order integration test asserting `trace.map(s => s.elementName)` for happy + failure paths.
- [ ] **Use cases are functions** — every business operation returns `Result<T, DomainError>`; each has a unit
      test against fake ports. No `this`; no class instances.
- [ ] **Composition root via `wire()`** — `wire(opts)` is pure (no filesystem / `os` touch); tests build
      `AppDeps` via `storagePathsFromRoot(tmpDir)` so no test ever writes to `~/.ralphctl/`.
- [ ] **Per-aggregate repositories** — `Project`, `Sprint`, `SprintExecution`, `Task`, `Settings` each own a
      repository under `domain/repository/<aggregate>/`. Business code consumes slim sub-ports from
      `domain/repository/_base/`, not composite `*Repository` types.
- [ ] **Result types** — `Result<T, E>` imported only from `@src/domain/result.ts`; ESLint blocks direct
      `typescript-result` imports.
- [ ] **Storage paths** — `resolveStoragePaths` honours `RALPHCTL_HOME`; on-disk layout is
      `<root>/{config,data,state}/…`. Per-sprint directory contains `sprint.json` + `execution.json` +
      `tasks.json` + `chain.log` + `progress.md` + per-flow sandbox folders.
- [ ] **Cross-project sprint lock** — `<stateRoot>/locks/sprints/<sprint-id>.lock` blocks two ralphctl
      processes from racing the same sprint. Stale-takeover via `RALPHCTL_LOCK_TIMEOUT_MS`.
- [ ] **`@public` JSDoc tag whitelist** — `pnpm deadcode` exits 0 on a clean tree; symbols intentionally kept
      after dead-code cleanup are tagged `@public`.

## Observability

- [x] **EventBus** — one bus per `wire()` call; bus state isolates between app instances. AppEvent variants:
      `ChainStarted`, `ChainStepStarted`, `ChainStepCompleted`, `ChainStepFailed`, `ChainCompleted`,
      `ChainFailed`, `ChainAborted`, `TaskAttemptStarted`, `TaskAttemptEvaluated`, `TaskRoundStarted`,
      `FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShowEvent`, `BannerClearEvent`,
      `MemoryPressureEvent`, `ChainLogDegradedEvent`, `LogEvent`.
- [ ] **Logger** — `createEventBusLogger({ eventBus, clock })` is the only `Logger` factory; every
      `logger.info(...)` publishes a `LogEvent`. `RALPHCTL_LOG_LEVEL` filters output.
- [x] **Persistent chain.log** — every `Implement` (and other long-running) chain run appends its trace to
      `<sprintDir>/chain.log`, bracketed by `=== chain-run <id> <flowId> started <iso> ===` /
      `… completed/failed/aborted …` delimiters. Survives TUI exit; `tail -f`-friendly.
- [ ] **Session scoping** — `AsyncLocalStorage` tags every log / signal emission with the owning chain's
      session id. Outside any chain, `currentSessionId()` returns `undefined`.
- [ ] **Harness signals** — `HarnessSignal` discriminated union exhaustiveness enforced at the compiler level;
      one sibling parser per variant under `integration/ai/signals/<variant>/`; unrecognised signals log a
      warning and continue.
- [x] **Harness-owned output writes** — `progress.md` (snapshot-rendered, not streamed), per-round
      `prompt.md` and `outcome.md`, `decisions.log`, and `tasks.json` are written by the harness, never by
      the AI. Atomic writes use the `WriteFile` port; `FileLocker` guards cross-process safety.

## Flow registry

- [ ] **Single registry** — `src/application/registry.ts` lists every user-launchable flow. Adding a flow is
      one append to `flowRegistry`. The CLI command builder, TUI menu, and launch logic all consume from the
      same array.
- [ ] **`pnpm gen:flow <name>`** — scaffolds the manifest + flow stub + tests so a new chain is added with the
      same shape as existing ones.
- [ ] **Trigger predicates** — each `FlowManifest.triggers` declares pre-launch readiness conditions
      (`requiresProject`, `currentSprintStatus`, `minPendingTickets`, `minApprovedTickets`,
      `minResumableTasks`). TUI menu disables and explains unmet triggers.

## Sprint lifecycle

Status flow: `draft → active → review → done`.

- [ ] **`draft → active`** — `implement` flow auto-activates a draft sprint that has tasks.
- [ ] **`active → review`** — `implement` transitions the sprint to `review` once every task is `done`.
- [ ] **`review → done`** — `sprint close <id>` (CLI) and the close-sprint flow (TUI) accept only
      `review`-status sprints.
- [ ] **No `task add / edit / remove`** — task mutation outside the planner is intentional. The CLI surface
      contains only `task list` and `task show`.
- [ ] **`sprint refine` / `plan` / `ideate` are draft-only** — running them on an active or later sprint is a
      precondition failure.

## Two-Phase Planning

- [ ] **Refine** (`refine` chain, TUI) — per-ticket HITL clarification; implementation-agnostic (no repo
      exploration); ticket status flips `pending → approved`.
- [ ] **Plan** (`plan` chain, TUI) — requires all tickets `approved`; repo selection runs inside the chain
      and persists on `Sprint.affectedRepositories` (absolute paths); AI generates `tasks.json` atomically.
- [ ] **Ideate** (`ideate` chain, TUI) — combines refine + plan in one session for low-stakes tickets.
- [ ] **Draft re-plan** — running `plan` on a draft sprint that already has tasks lets the AI see the existing
      tasks; the new plan atomically replaces the old one after user confirmation.

## Implement flow

- [ ] **Sequential execution** — tasks run strictly one at a time in topological order over `Task.blockedBy`.
- [ ] **Per-task generator-evaluator loop** — `loop` primitive runs `generator → evaluator → settle-attempt`
      per round. Exits when the evaluator passes or `maxAttempts` is hit (then transition to `blocked`).
- [ ] **Per-flow model selection** — `settings.ai.models.implement` selects the model used for the generator;
      `settings.ai.models.implement` (same key, but evaluator may be a different ladder rung internally).
- [x] **`setupScript` runs unconditionally once per affected repo at sprint start** — outcome recorded as a
      structured `SetupRun` on `SprintExecution.setupRanAt`; any failure hard-aborts the chain with the
      failing repo named.
- [x] **`checkScript` gates per-task settlement with pre/post attribution** — runs before the AI (pre-task)
      and after commit (post-task). Attribution: `clean` / `regressed` / `baseline-broken` / `fixed-baseline`.
      A `baseline-broken` result does not block the AI; a `regressed` result transitions task to `blocked`.
- [ ] **Branch management** — `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
      per-task preflight verifies the right branch is checked out.
- [x] **Resume of aborted runs** — tasks left in `in_progress` from a prior crash reset to `todo` and
      re-enter the queue on next launch. The resume-from-aborted header surfaces in the TUI as
      "attempt N · resumed from aborted M at HH:MM (cause)" using the `AbortCause` discriminated union.
- [ ] **Rate-limit retry** — adapter-side exponential backoff on `RateLimitError`; capped by
      `settings.harness.rateLimitRetries`.
- [ ] **Idle-stdout watchdog** — wedged headless AI children get killed after a configurable idle threshold.
- [x] **EventBus emissions** — chain runner emits `ChainStarted` → per-step `ChainStepStarted/Completed/Failed`
      → `ChainCompleted/Failed/Aborted`; per-task `TaskAttemptStarted` / `TaskAttemptEvaluated` /
      `TaskRoundStarted` (carrying `roundN`, `attemptN`, `totalCap`).
- [x] **Plateau predicate** — consecutive evaluator rounds flagging the same failed-dimension set exit the
      loop with a plateau warning after `settings.harness.plateauThreshold` (2–5, default 2) rounds.
      Score improvement, commit-message change, or critique-Jaccard shift exempts a round.
- [x] **Token-usage event** — `TokenUsageEvent` emitted once per spawn (model, context window,
      input/output, cache tokens). TUI `TokenBudgetCard` subscribes.
- [x] **Per-round artifacts** — generator and evaluator prompts written to
      `rounds/<N>/{generator,evaluator}/prompt.md` before each spawn; `outcome.md` written to
      `rounds/<N>/outcome.md` after settlement.
- [x] **Decisions log** — `<sprintDir>/decisions.log` captures AI-emitted `<decision>` tags;
      merged into `progress.md § Decisions`.
- [x] **Notifications** — terminal bell + macOS `osascript` fire on attention events when
      `settings.ui.notifications.enabled` is `true` (default).
- [x] **Snapshot CLI** — `ralphctl snapshot [--sprint <id>]` renders one deterministic text frame of the
      active sprint's `SprintState` to stdout.

## Review flow (apply-feedback)

- [ ] **Distinct chain** — `review` flow lives in `application/flows/review/`; not embedded inside `implement`.
- [ ] **Free-form feedback** — multi-line editor prompt; empty submission terminates the loop.
- [x] **AI session resumes via session id** — the harness reads back the per-task `sessionId` file from
      `<sprintDir>/implement/<unit>/rounds/<N>/generator/sessionId` and resumes the relevant task's session.
- [ ] **EventBus emits `FeedbackRoundApplied`** per round.

## AI provider integration

- [ ] **Three providers** — `claude-code`, `github-copilot`, `openai-codex`, each with its own adapter under
      `integration/ai/providers/<tool>/`. Sibling-isolated; cross-tool sharing through `providers/_engine/`.
- [x] **File-based contract** — providers write `signals.json` and `sessionId` files per spawn (both under
      `rounds/<N>/<role>/`); the harness reads them post-spawn. No stdout parsing for signals or session IDs.
- [ ] **Idle-stdout watchdog** — wedged children get reaped.
- [ ] **Exponential backoff** — rate-limit retries use `rate-limit-backoff.ts` (`integration/ai/providers/_engine/`).
- [ ] **Interactive variant** — `InteractiveAiProvider` hands over the terminal (alt-screen swap to the AI's
      own UI); the TUI restores its alt-screen state on the way back.
- [ ] **Bundled skills** — `installSkillsLeaf` / `uninstallSkillsLeaf` bracket every AI session that benefits
      from defaults. Skills are copied into `<repo>/<parentDir>/skills/ralphctl-<name>/` and git-excluded via a
      single `ralphctl-*` wildcard appended to `.git/info/exclude`. Project skills always win over bundled ones.
      Adapter is no-op for Codex / Copilot today.
- [ ] **Provider-native context file** — `readiness` flow writes `CLAUDE.md` (Claude),
      `.github/copilot-instructions.md` (Copilot), or `AGENTS.md` (Codex) based on `settings.ai.provider`.

## Per-flow model selection

- [ ] **Settings shape** — `settings.ai.models` is an object keyed by chain (`refine` / `plan` / `implement` /
      `readiness` / `ideate`). Each flow reads its own model from this map.
- [ ] **Provider × model validation** — model values must be in the configured provider's catalog
      (`src/domain/value/settings-models/<provider>.ts`); the persistence schema rejects invalid combos at
      load time.

## Doctor

- [ ] **`ralphctl doctor`** runs every check; per-check rows with status (`pass` / `warn` / `fail`); an
      aggregate result card at the bottom.
- [ ] **TUI doctor hotkey** opens the same view from anywhere.
- [ ] **Onboarding-status check** reports per-(project, repo) onboarding state.

## Settings

- [ ] **Schema-driven settings panel** — TUI rows iterate the `SettingsSchema`; each row's prompt kind
      derives from the field's value type. Edits save immediately via `SettingsRepository.save()`.
- [ ] **CLI parity** — `ralphctl settings show` prints the current settings; `ralphctl settings set <key> <value>`
      sets a single key.
- [ ] **Schema validation on read** — corrupt or v0.6.x-shaped `settings.json` files surface a typed
      `ParseError` with a re-run hint (`ralphctl settings`).
- [ ] **`schemaVersion`** — written on every save; migration path runs before validation if the on-disk shape
      changes in a future version.

## CLI surface

- [x] **Surface is deliberately smaller than v0.6.x** — interactive flows (refine / plan / ideate / implement /
      readiness / create-sprint) stay TUI-only. The CLI exposes only inspection commands + one-shot operations:
      `doctor`, `completion <shell>`, `export-context`, `export-requirements`, `create-pr`,
      `settings {show,set}`, `project {list,show,remove}`,
      `sprint {list,show,set-current,activate,close,remove,progress}`,
      `ticket {list,show,add,remove}`, `task {list,show}`,
      `runs {list,prune}`, `snapshot`.
- [ ] **Each one-shot command** has a `tests/e2e/cli/<name>.test.ts` pinning the success-path stdout.
- [ ] **Exit codes** — `0` success, `1` error, `130` interrupted.

## TUI

See [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) for tokens, components, view patterns, and copy rules.

- [ ] **Alt-screen takeover** — bare `ralphctl` enters the alt-screen buffer + hides cursor; restored via
      explicit exit + signal-safe handlers (`exit` / `SIGINT` / `SIGTERM` / `SIGHUP` / `uncaughtException`).
- [ ] **Non-TTY fallback** — `CI=1` / `RALPHCTL_NO_TUI=1` / piped invocations skip the Ink mount.
- [ ] **Persistent banner** — `<Banner />` renders on every view via `<ViewShell />`. Quote stabilises at
      module load.
- [ ] **Help overlay** — `?` opens `<HelpOverlay />`; rendered from the centralised keyboard map.
- [ ] **Centralised keyboard map** — one table; adding a binding is one edit.
- [ ] **Multi-flow nav** — Tab / Shift+Tab cycle running flow sessions; `Ctrl+1..9` direct-jump;
      `SessionsView` lists every runner with status + age.
- [ ] **Live execute view** — `ExecuteView` subscribes to the EventBus; renders `StepTrace` + `TasksPanel` +
      `RecentEventsTail`. Late attach is lossless (synthetic replay).
- [ ] **Prompt transcript** — resolved prompts render dim above the live prompt; history clears when the
      prompt queue idles past `SEQUENCE_IDLE_MS`.
- [ ] **Form retry loop** — sprint-create / project-add / ticket-add / project-edit views retry on validation
      errors instead of popping back to home.
- [x] **Responsive Execute view** — three-column (rail / tasks / context) at ≥180 cols; two-column at ≥140
      cols; compact-rail at 100–139 cols; single-column below 100 cols.
- [x] **TUI hotkeys** — `b` banner compact ↔ full toggle; `g` progress overlay (reads `progress.md` on
      demand); `y` yank active-task summary to clipboard; `j`/`k` task-card navigation; `e` expand
      done-criteria for active card; `c` cancel-scope picker (attempt vs whole flow).
- [x] **Baseline-health card + chip** — `BaselineHealthCard` and `BaselineHealthChip` surface
      `SprintExecution.setupRanAt` history in the context column.
- [x] **Token-budget card** — `TokenBudgetCard` subscribes to `TokenUsageEvent`; renders
      `(input + output) / contextWindow` when both are known.
- [x] **Status banner** — tiered `info` / `warn` / `error` `StatusBanner` replaces the old
      single-purpose `RateLimitBanner`. Driven by `BannerShowEvent` / `BannerClearEvent`.
- [x] **Evaluator-failure panel** — `EvaluatorFailurePanel` shows per-dimension scores with expand
      affordance. Gated behind `settings.developer.showEvaluatorFailureUI` (default `false`).
- [x] **NO_COLOR accessibility** — `glyphFor(signalKind)` adds shape-redundant glyphs so signal kinds
      remain visually distinguishable when `NO_COLOR=1` suppresses colour encoding.
- [x] **Idle-state ticker** — tasks panel shows last-note signals when no task is `in_progress`.
- [x] **ETA estimate** — attempt header shows a median-round-duration ETA derived from past settled
      attempts for the same task.

## Build & Distribution

- [ ] **Two-stage build** — `tsup` compiles `dist/cli.mjs`; `tsx scripts/build-assets.ts` copies prompts +
      bundled skills into `dist/{prompts,skills}/` and writes `dist/manifest.json`.
- [ ] **Dual-mode loading** — `FsTemplateLoader` and `bundledSkillSource` detect bundled mode via
      `import.meta.url`. Dev reads from `src/`; bundled reads from `dist/`.
- [ ] **Asset verification** — missing or corrupt assets fail fast at load time with a repair hint.
- [ ] **CI tarball smoke** — `pnpm pack` + `npm install` into a tmp dir + `ralphctl --version` from arbitrary
      cwd exits 0 with `0.7.0`.
- [ ] **`--provenance`** flag on npm publish.

## Migration from v0.6.x

- [ ] **No automatic migration** — v0.7.0 does not read `~/.ralphctl/`. v0.6.x data is left untouched at its
      old location.
- [ ] **README upgrade notice** — `README.md` opens with the 0.6.x → 0.7.0 upgrade section listing the
      breaking changes.
- [ ] **CHANGELOG section** — `## [0.7.0] - 2026-05-17` lists Breaking / Added / Changed / Removed.
- [ ] **Legacy `settings.json` is rejected on read** — surface a `ParseError`, not a half-decoded record.

## Things deliberately deferred

- **Concurrent task fan-out** — `settings.concurrency.maxParallelTasks` is wired but only `1` is supported
  today. Needs a new chain primitive.
- **User-skill consumption** — `SkillSuggestionsSignal` is parsed but no flow consumes it yet.
- **Real-provider e2e tests** — every Claude / Copilot / Codex provider test uses a fake `spawn`.
- **Bundle-mode detection robustness** — `import.meta.url.endsWith('/cli.mjs')` is a fragile detection; a
  follow-up should switch to `existsSync(<here>/manifest.json)`.
