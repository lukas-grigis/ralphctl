# RalphCTL — Acceptance Criteria

Testable acceptance criteria, current as of v0.9.x. Read on demand — this file is not auto-imported into every
Claude session. Source of truth for narrative constraints lives elsewhere; pointers below.

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
      `tasks.json` + `progress.md` + per-flow sandbox folders. `events.ndjson` lands here too when
      `RALPHCTL_DEBUG_TRACE=1` (opt-in debug sink, no-op otherwise).
- [ ] **Cross-process repo lock** — `<stateRoot>/locks/repo-<hash>.lock/` (lock directory, sha1 of the sprint dir path)
      blocks two ralphctl processes from racing the same sprint. Both implement and review key on the sprint dir, so they
      mutually exclude. A **heartbeat** keeps a live holder's lock perpetually fresh — stale-takeover fires only after a
      crashed holder's mtime passes `DEFAULT_STALE_AFTER_MS` (30s, clamped 2000ms..1h) — not env-configurable. A
      compromised lock aborts the in-flight run as an `AbortError`.
- [ ] **`@public` JSDoc tag whitelist** — `pnpm deadcode` exits 0 on a clean tree; symbols intentionally kept
      after dead-code cleanup are tagged `@public`.

## Observability

- [x] **EventBus** — one bus per `wire()` call; bus state isolates between app instances. AppEvent variants:
      `ChainStarted`, `ChainStepStarted`, `ChainStepCompleted`, `ChainStepFailed`, `ChainCompleted`,
      `ChainFailed`, `ChainAborted`, `TaskAttemptStarted`, `TaskAttemptEvaluated`, `TaskRoundStarted`,
      `FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShowEvent`, `BannerClearEvent`,
      `MemoryPressureEvent`, `ChainLogDegradedEvent`, `HarnessSignalEvent`, `AiSignalEvent`,
      `ModelEscalatedEvent`, `LogEvent`.
- [ ] **Logger** — `createEventBusLogger({ eventBus, clock })` is the only `Logger` factory; every
      `logger.info(...)` publishes a `LogEvent`. The log floor is `settings.logging.level` (default `info`),
      applied by the bus → logger consumer via `createLogLevelGate` / `passesLogLevel` — not an env var.
- [x] **Optional events.ndjson** — opt-in via `RALPHCTL_DEBUG_TRACE=1`. When enabled, every `Implement` (and
      other long-running) chain run appends its trace to `<sprintDir>/events.ndjson`, bracketed by
      `=== chain-run <id> <flowId> started <iso> ===` / `… completed/failed/aborted …` delimiters.
      Survives TUI exit; `tail -f`-friendly. Bounded in-memory drain queue with drop-newer back-pressure
      so the sink cannot OOM. Default factory is no-op; harness state never reads from events.ndjson.
- [ ] **Session scoping** — `AsyncLocalStorage` tags every log / signal emission with the owning chain's
      session id. Outside any chain, `currentSessionId()` returns `undefined`.
- [ ] **Harness signals** — `HarnessSignal` discriminated union exhaustiveness enforced at the compiler
      level; one Zod schema per kind under `integration/ai/contract/_engine/signals/<kind>/schema.ts`;
      `validateSignalsFile` rejects unknown shapes with a precise hint.
- [x] **Harness-owned output writes** — `progress.md` (append-only journal — header at creation, one section
      appended per settled attempt), per-round `prompt.md` and `outcome.md`, and `tasks.json` are written by
      the harness, never by the AI. Atomic writes use the `WriteFile` port; `FileLocker` guards cross-process safety.

## Flow registry

- [ ] **Single registry** — `src/application/registry.ts` lists every user-launchable flow. Adding a flow is
      one append to `flowRegistry`. The CLI command builder, TUI menu, and launch logic all consume from the
      same array.
- [ ] **Trigger predicates** — each `FlowManifest.triggers` declares pre-launch readiness conditions
      (`requiresProject`, `currentSprintStatus`, `minPendingTickets`, `minApprovedTickets`,
      `minResumableTasks`). TUI menu disables and explains unmet triggers.

## Sprint lifecycle

Status flow: `draft → planned → active → review → done`.

- [ ] **`draft → planned`** — the `plan` flow generates `tasks.json` and transitions the sprint to `planned`.
- [ ] **`planned → active`** — `implement` activates a `planned` sprint on first launch; an already-`active`
      sprint passes through idempotently.
- [ ] **`active → review`** — `implement` transitions the sprint to `review` once every task has settled
      (`done` or `blocked`) AND at least one task settled `done`. An all-blocked run stays `active`
      (`shouldTransitionToReview` in `implement/flow.ts`).
- [ ] **`review → done`** — `sprint close <id>` (CLI) and the close-sprint flow (TUI) accept only
      `review`-status sprints.
- [ ] **No `task add / edit / remove`** — bulk task mutation outside the planner is intentional. The CLI
      task surface is read-only plus the single recovery action `task unblock` (blocked → todo); there is no
      `task add` / `task edit` / `task remove`.
- [ ] **`sprint refine` / `plan` / `ideate` are draft-only** — running them on an active or later sprint is a
      precondition failure.

## Two-Phase Planning

- [ ] **Refine** (`refine` chain, TUI) — per-ticket HITL clarification; implementation-agnostic (no repo
      exploration); ticket status flips `pending → approved`.
- [ ] **Plan** (`plan` chain, TUI) — requires all tickets `approved`; repo selection runs inside the chain
      and persists on `Sprint.affectedRepositories` (absolute paths); AI generates `tasks.json` atomically.
- [x] **Ideate** (`ideate` chain, TUI) — combines refine + plan in one session for low-stakes tickets;
      transitions the sprint `draft → planned` after the plan phase, making the Implement flow reachable.
- [ ] **Draft re-plan** — running `plan` on a draft sprint that already has tasks lets the AI see the existing
      tasks; the new plan atomically replaces the old one after user confirmation.

## Implement flow

- [x] **Dependency-ordered execution with opt-in parallelism** — tasks are scheduled by `scheduleIntoWaves`
      (topological Kahn's-by-level over `Task.dependsOn`, `Task.order` ASC within each level);
      `validateTaskGraph` runs at BOTH parse time and implement-launch time, so a cyclic or dangling
      graph fails fast with the rendered issue. When `settings.concurrency.maxParallelTasks === 1`
      (default), levels flatten into one serial queue — byte-for-byte the prior behaviour. When
      `maxParallelTasks > 1` (1–5), `runWaves` runs each wave's tasks concurrently up to that cap;
      waves stay strictly sequential. Each task runs in its own isolated git worktree
      (`<sprintDir>/worktrees/wt-<taskId>`); commits are folded onto one sprint branch (one PR). A fold
      conflict transitions the second task to `blocked`; relaunching re-forks from the advanced tip.
- [x] **Per-task generator-evaluator loop** — the attempt body is
      `start-attempt → pre-task-verify → gen-eval inner loop (generator/evaluator per turn) → finalize → post-task-verify → commit (guarded) → settle-attempt → append-learnings → progress-journal`,
      wrapped in an outer `loop` over attempts.
      Exits when the evaluator passes or `maxAttempts` is hit (then transition to `blocked`).
      A single launch runs the outer attempt loop up to `maxAttempts` times per task (`maxAttempts === 1`
      preserves the prior single-attempt-per-launch behaviour).
- [ ] **Per-flow model selection** — `settings.ai.implement` is a nested `{ generator, evaluator }` pair; each
      role carries its own `{ provider, model, effort? }` row, so the produce and score sessions can run on
      different providers / models / effort levels.
- [x] **`setupScript` runs unconditionally once per affected repo at sprint start** — outcome recorded as a
      structured `SetupRun` on `SprintExecution.setupRanAt`; any failure hard-aborts the chain with the
      failing repo named.
- [x] **`verifyScript` gates per-task settlement with pre/post attribution** — runs before the AI (pre-task)
      and after commit (post-task). Attribution: `clean` / `regressed` / `baseline-broken` / `fixed-baseline`.
      A `baseline-broken` result does not block the AI; a `regressed` result transitions task to `blocked`.
      `Repository.verifyTimeout` is forwarded as `timeoutMs` to both calls; absent → 5-min runner default.
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
- [x] **Decision capture** — AI-emitted `<decision>` tags accumulate per-attempt on the implement ctx and
      render as the `### Decisions` subsection of each `progress.md` journal entry (audit-[07] retired the
      standalone `decisions.log` sink).
- [x] **Notifications** — terminal bell + macOS `osascript` fire on attention events when
      `settings.ui.notifications.enabled` is `true` (default).

## Review flow (apply-feedback)

- [ ] **Distinct chain** — `review` flow lives in `application/flows/review/`; not embedded inside `implement`.
- [ ] **Free-form feedback** — multi-line editor prompt; empty submission terminates the loop.
- [x] **AI session resumes via session id** — the harness reads back the per-task `session-id.txt` file from
      `<sprintDir>/implement/<unit>/rounds/<N>/generator/session-id.txt` and resumes the relevant task's session.
- [ ] **EventBus emits `FeedbackRoundApplied`** per round.

## AI provider integration

- [ ] **Three providers** — `claude-code`, `github-copilot`, `openai-codex`, each with its own adapter under
      `integration/ai/providers/<tool>/`. Sibling-isolated; cross-tool sharing through `providers/_engine/`.
- [x] **File-based contract** — providers write `signals.json` and `session-id.txt` files per spawn (both under
      `rounds/<N>/<role>/`); the harness reads them post-spawn. No stdout parsing for signals or session IDs.
- [ ] **Idle-stdout watchdog** — wedged children get reaped.
- [ ] **Exponential backoff** — rate-limit retries use `rate-limit-backoff.ts` (`integration/ai/providers/_engine/`).
- [ ] **Interactive variant** — `InteractiveAiProvider` hands over the terminal (alt-screen swap to the AI's
      own UI); the TUI restores its alt-screen state on the way back.
- [x] **Bundled skills** — `installSkillsLeaf` / `uninstallSkillsLeaf` bracket every AI session that benefits
      from defaults. Skills are copied into `<repo>/<parentDir>/skills/ralphctl-<name>/` and git-excluded via a
      single `ralphctl-*` wildcard appended to `.git/info/exclude`. Project skills always win over bundled ones.
      Eight bundled skills ship (`ralphctl-abstraction-first`, `ralphctl-alignment`, `ralphctl-iterative-review`,
      `ralphctl-minimal-scaffolding`, `ralphctl-debugging-and-error-recovery`, `ralphctl-code-review-and-quality`,
      `ralphctl-test-driven-development`, `ralphctl-surgical-simplicity`). Each is validated by
      `skill-contract-checker.ts` (hard-fail on contract violation) before it can ship.
      Operator drop-in skills (`~/.ralphctl/skills/{claude,copilot,codex}/…`) install through the same path;
      violations are warnings only.
- [ ] **Provider-native context file** — the `readiness` flow fans out across every uniquely referenced
      provider in `settings.ai`, writing one native context file per distinct provider: `CLAUDE.md`
      (claude-code), `.github/copilot-instructions.md` (github-copilot), `AGENTS.md` (openai-codex). A
      single-provider config produces exactly one file; mixed configs produce one per distinct provider.

## Per-flow model selection

- [ ] **Settings shape** — `settings.ai` is a flat record: an optional global `ai.effort` plus per-flow rows
      `ai.{refine,plan,readiness,ideate,createPr}` (each `{ provider, model, effort? }`) and a nested
      `ai.implement.{generator,evaluator}` pair. `detect-scripts`/`detect-skills` reuse the `readiness` row and
      `review` reuses the `implement` row — there is no `settings.ai.models` sub-object. Each flow reads its own
      provider/model/effort.
- [ ] **Provider × model validation** — a row's `model` must be either in the configured provider's catalog
      (`src/domain/value/settings-models/<provider>.ts`) or any non-empty trimmed custom string; the per-flow
      `effort` validates against the provider's native vocabulary. Custom (off-catalog) model ids parse at load
      time and are rejected by the provider CLI at spawn time, not by the persistence schema.

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
      `settings {show,set,apply-preset}`, `project {list,show,remove}`,
      `sprint {list,show,set-current,activate,close,remove,progress}`,
      `ticket {list,show,add,remove}`, `task {list,show,unblock}`,
      `runs {list,prune}`.
- [ ] **Each one-shot command** has a `tests/e2e/cli/<name>.test.ts` pinning the success-path stdout.
- [ ] **Exit codes** — `0` success, `1` error, `130` interrupted.

## TUI

See [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) for tokens, components, view patterns, and copy rules.

- [ ] **Alt-screen takeover** — bare `ralphctl` enters the alt-screen buffer + hides cursor; restored via
      explicit exit + signal-safe handlers (`exit` / `SIGINT` / `SIGTERM` / `SIGHUP` / `uncaughtException`).
- [ ] **Non-TTY fallback** — `CI=1` / `RALPHCTL_NO_TUI=1` / piped invocations skip the Ink mount. _Not yet
      wired: the bare-command mount is currently unconditional; `CI` / `RALPHCTL_NO_TUI` only gate implicit
      interactive prompting inside the `implement` flow (`pre-task-verify.ts`)._
- [ ] **Persistent banner** — `<Banner />` renders on every view via `<ViewShell />`. Quote stabilises at
      module load.
- [ ] **Help overlay** — `?` opens `<HelpOverlay />`; rendered from the centralised keyboard map.
- [ ] **Centralised keyboard map** — one table; adding a binding is one edit.
- [x] **Multi-flow nav** — Tab / Shift+Tab cycle running flow sessions; `Ctrl+1..9` direct-jump;
      `SessionsView` lists every runner with status + age. Both chords are gated off while a prompt
      or overlay is mounted.
- [ ] **Live execute view** — `ExecuteView` subscribes to the EventBus; renders `StepTrace` + `TasksPanel` +
      `RecentEventsTail`. Late attach is lossless (synthetic replay).
- [ ] **Prompt transcript** — resolved prompts render dim above the live prompt; history clears when the
      prompt queue idles past `SEQUENCE_IDLE_MS`.
- [ ] **Form retry loop** — sprint-create / project-add / ticket-add / project-edit views retry on validation
      errors instead of popping back to home.
- [x] **Windowed-list primitive** — all long, scrollable, homogeneous lists mount through
      `windowed-list.tsx` (`computeListWindow` / `useListWindow` / `WindowedList` / `OverflowRow`). Id-based
      cursor survives reorder/eviction. `↑/↓` primary, `j`/`k` alias, `PgUp`/`PgDn` page, `Home`/`End` jump.
      `▴/▾` overflow cues. `ScrollRegion` passes `suppressArrows` when a list owns the cursor.
- [x] **Responsive Execute view** — three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail
      at `md` (100–139), single-column below `md`. Rail grows fluidly 36→56 cols at `xl`+ via
      `resolveRailWidth`. `StepTrace` renders `Element.label` when present; long labels mid-truncated to
      fit the rail column budget.
- [x] **TUI hotkeys** — `b` banner compact ↔ full toggle; `g` progress overlay (reads `progress.md` on
      demand); `y` yank active-task summary to clipboard; `P` cross-project project picker; `S`
      cross-project sprint picker (with `t` toggle-scope inside the picker); `j`/`k` task-card navigation;
      `e` expand done-criteria for active card; `c` cancel-scope picker (attempt vs whole flow).
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
      cwd exits 0 and prints the version from `package.json`.
- [ ] **`--provenance`** flag on npm publish.

## Migration from v0.6.x

- [ ] **No automatic migration** — v0.7.0 does not read `~/.ralphctl/`. v0.6.x data is left untouched at its
      old location.
- [ ] **README upgrade notice** — `README.md` opens with the 0.6.x → 0.7.0 upgrade section listing the
      breaking changes.
- [ ] **CHANGELOG section** — `## [0.7.0] - 2026-05-18` lists Breaking / Added / Changed / Removed.
- [ ] **Legacy `settings.json` is rejected on read** — surface a `ParseError`, not a half-decoded record.

## Things deliberately deferred

- **File-overlap-aware wave partitioning** — today, two same-wave tasks that touch the same file resolve
  at fold time (first folds, second's cherry-pick conflicts → `blocked`; relaunch re-forks from the
  advanced tip and usually succeeds). Pre-partitioning waves by file overlap to eliminate the conflict
  case is deferred.
- **Cross-provider escalation** — escalation today stays within a provider (e.g. Sonnet → Opus); switching
  providers mid-task carries auth/context/tool hazards and is deferred.
- **Real-provider e2e tests** — every Claude / Copilot / Codex provider test uses a fake `spawn`.
- **Bundle-mode detection robustness** — `import.meta.url.endsWith('/cli.mjs')` is a fragile detection; a
  follow-up should switch to `existsSync(<here>/manifest.json)`.

## Procedural memory

- [x] **Learning ledger** — per-attempt `<learning>` signals appended (best-effort) to
      `<dataRoot>/memory/<projectId>/learnings.ndjson`; records carry `id`, `text`, `repo`, `repoName`,
      `taskKind`, `sprintId`, `taskId`, `timestamp`, and `promotedAt` (null until distilled).
- [x] **Distill step (opt-in)** — at sprint close (both `close-sprint` and `review` auto-done paths) a
      human-gated step (default: No) promotes curated learnings into each provider's native context file
      via the per-distinct-provider fan-out (one file per provider, no symlinks). Runs while the sprint is
      still `review` so an abort leaves it re-runnable.
- [x] **Skill suggestions acted on** — the `readiness` flow offers to install/scaffold each
      `SkillSuggestionsSignal` entry; human gate mandatory (no auto-install); accepted suggestions
      persisted on `Repository.suggestedSkills`.
