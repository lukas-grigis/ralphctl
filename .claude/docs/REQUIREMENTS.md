# RalphCTL — Acceptance Criteria

Testable acceptance criteria, current as of the latest release. Read on demand — this file is not auto-imported into every
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

- [x] **Clean Architecture layering** — see [CLAUDE.md § Architecture Constraints](../../CLAUDE.md). Acceptance:
      ESLint `no-restricted-imports` passes, `pnpm typecheck` is green.
- [x] **No `class` outside `src/domain/value/error/`** — ESLint asserts.
- [x] **No barrel files anywhere under `src/`** — `export *` blocked by ESLint.
- [x] **Sibling-isolation rules** — each per-tool / per-variant adapter directory under
      `integration/ai/<concept>/` is independent; cross-sibling access goes through `_engine/`. Same applies to
      `business/<module>/` and `application/flows/<flow>/`.
- [x] **Chain framework primitives** — see [KERNEL-DESIGN.md](./KERNEL-DESIGN.md). Acceptance: every primitive
      (`leaf` / `sequential` / `loop` / `guard`) has unit tests in isolation; every flow definition has a
      step-order integration test asserting `trace.map(s => s.elementName)` for happy + failure paths.
- [x] **Use cases are functions** — every business operation returns `Result<T, DomainError>`; each has a unit
      test against fake ports. No `this`; no class instances.
- [x] **Composition root via `wire()`** — `wire(opts)` is pure (no filesystem / `os` touch); tests build
      `AppDeps` via `storagePathsFromRoot(tmpDir)` so no test ever writes to `~/.ralphctl/`.
- [x] **Per-aggregate repositories** — `Project`, `Sprint`, `Task`, `Settings` each own a directory under
      `domain/repository/<aggregate>/`; `SprintExecution`'s repository lives alongside Sprint at
      `domain/repository/sprint/sprint-execution-repository.ts`. Business code consumes slim sub-ports from
      `domain/repository/_base/`, not composite `*Repository` types.
- [x] **Result types** — `Result<T, E>` imported only from `@src/domain/result.ts`; ESLint blocks direct
      `typescript-result` imports.
- [x] **Storage paths** — `resolveStoragePaths` honours `RALPHCTL_HOME`; on-disk layout is
      `<root>/{config,data,state}/…`. Per-sprint directory contains `sprint.json` + `execution.json` +
      `tasks.json` + `progress.md` + per-flow sandbox folders. `events.ndjson` lands here too when
      `RALPHCTL_DEBUG_TRACE=1` (opt-in debug sink, no-op otherwise).
- [x] **Cross-process repo lock** — `<stateRoot>/locks/repo-<hash>.lock/` (lock directory, sha1 of the sprint dir path)
      blocks two ralphctl processes from racing the same sprint. Both implement and review key on the sprint dir, so they
      mutually exclude. A **heartbeat** keeps a live holder's lock perpetually fresh — stale-takeover fires only after a
      crashed holder's mtime passes `DEFAULT_STALE_AFTER_MS` (30s, clamped 2000ms..1h) — not env-configurable. A
      compromised lock aborts the in-flight run as an `AbortError`.
- [x] **`@public` JSDoc tag whitelist** — `pnpm deadcode` exits 0 on a clean tree; symbols intentionally kept
      after dead-code cleanup are tagged `@public`.

## Observability

- [x] **EventBus** — one bus per `wire()` call; bus state isolates between app instances. AppEvent variants:
      `ChainStarted`, `ChainStepStarted`, `ChainStepCompleted`, `ChainStepFailed`, `ChainCompleted`,
      `ChainFailed`, `ChainAborted`, `TaskAttemptStarted`, `TaskAttemptEvaluated`, `TaskRoundStarted`,
      `FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShowEvent`, `BannerClearEvent`,
      `MemoryPressureEvent`, `ChainLogDegradedEvent`, `HarnessSignalEvent`, `AiSignalEvent`,
      `ModelEscalatedEvent`, `LogEvent`.
- [x] **Logger** — `createEventBusLogger({ eventBus, clock })` is the only `Logger` factory; every
      `logger.info(...)` publishes a `LogEvent`. The log floor is `settings.logging.level` (default `info`),
      applied by the bus → logger consumer via `createLogLevelGate` / `passesLogLevel` — not an env var.
- [x] **Optional events.ndjson** — opt-in via `RALPHCTL_DEBUG_TRACE=1`. When enabled, every `Implement` (and
      other long-running) chain run appends its trace to `<sprintDir>/events.ndjson`, bracketed by
      `=== chain-run <id> <flowId> started <iso> ===` / `… completed/failed/aborted …` delimiters.
      Survives TUI exit; `tail -f`-friendly. Bounded in-memory drain queue with drop-newer back-pressure
      so the sink cannot OOM. Default factory is no-op; harness state never reads from events.ndjson.
- [x] **Session scoping** — `AsyncLocalStorage` tags every log / signal emission with the owning chain's
      session id. Outside any chain, `currentSessionId()` returns `undefined`.
- [x] **Harness signals** — `HarnessSignal` discriminated union exhaustiveness enforced at the compiler
      level; one Zod schema per kind under `integration/ai/contract/_engine/signals/<kind>/schema.ts`;
      `validateSignalsFile` rejects unknown shapes with a precise hint.
- [x] **Harness-owned output writes** — `progress.md` (append-only journal — header at creation, one section
      appended per settled attempt), per-round `prompt.md` and `outcome.md`, and `tasks.json` are written by
      the harness, never by the AI. Atomic writes use the `WriteFile` port; `FileLocker` guards cross-process safety.

## Flow registry

- [x] **Single registry** — `src/application/registry.ts` lists every user-launchable flow. Adding a flow is
      one append to `flowRegistry`. The CLI command builder, TUI menu, and launch logic all consume from the
      same array.
- [x] **Trigger predicates** — each `FlowManifest.triggers` declares pre-launch readiness conditions
      (`requiresProject`, `currentSprintStatus`, `minPendingTickets`, `minApprovedTickets`,
      `minResumableTasks`). TUI menu disables and explains unmet triggers.

## Sprint lifecycle

Status flow: `draft → planned → active → review → done`.

- [x] **`draft → planned`** — the `plan` flow generates `tasks.json` and transitions the sprint to `planned`.
- [x] **`planned → active`** — `implement` activates a `planned` sprint on first launch; an already-`active`
      sprint passes through idempotently.
- [x] **`active → review`** — `implement` transitions the sprint to `review` once every task has settled
      (`done` or `blocked`) AND at least one task settled `done`. An all-blocked run stays `active`
      (`shouldTransitionToReview` in `implement/flow.ts`).
- [x] **`review → done`** — `sprint close <id>` (CLI) and the close-sprint flow (TUI) accept only
      `review`-status sprints.
- [x] **No `task add / edit / remove`** — bulk task mutation outside the planner is intentional. The CLI
      task surface is read-only plus the single recovery action `task unblock` (blocked → todo); there is no
      `task add` / `task edit` / `task remove`.
- [x] **`sprint refine` / `plan` / `ideate` are draft-only** — running them on an active or later sprint is a
      precondition failure.

## Two-Phase Planning

- [x] **Refine** (`refine` chain, TUI) — per-ticket HITL clarification; implementation-agnostic (no repo
      exploration); ticket status flips `pending → approved`.
- [x] **Plan** (`plan` chain, TUI) — requires all tickets `approved` (`planSprint` rejects any `pending`
      ticket); the project's configured repositories (`project.repositories`, absolute paths) are mounted as
      equal `--add-dir` sources and the AI assigns each task an absolute `projectPath`; AI generates
      `tasks.json` atomically (`writeJsonAtomic`).
- [x] **Ideate** (`ideate` chain, TUI) — combines refine + plan in one session for low-stakes tickets;
      transitions the sprint `draft → planned` after the plan phase, making the Implement flow reachable.
- [x] **Draft re-plan** — running `plan` on a draft sprint that already has tasks lets the AI see the existing
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
      Exits when the evaluator passes, `maxAttempts` is hit (transition to `blocked`), or a red post-verify
      with attribution `regressed` exhausts the attempt budget (also `blocked`; within budget it retries with
      the failing evidence in the generator prompt via `RETRY_FEEDBACK_SECTION`).
      A single launch runs the outer attempt loop up to `maxAttempts` times per task (`maxAttempts === 1`
      preserves the prior single-attempt-per-launch behaviour).
- [x] **Per-flow model selection** — `settings.ai.implement` is a nested `{ generator, evaluator }` pair; each
      role carries its own `{ provider, model, effort? }` row, so the produce and score sessions can run on
      different providers / models / effort levels.
- [x] **`setupScript` runs once per affected repo per sprint** — outcome recorded as a structured `SetupRun`
      on `SprintExecution.setupRanAt`; on resume a repo with a prior matching `success` row is skipped
      (command drift forces a re-run); any failure hard-aborts the chain with the failing repo named.
- [x] **`verifyScript` / `verifyGates` gates per-task settlement with pre/post attribution** — runs before the
      AI (pre-task) and after commit (post-task). Attribution: `clean` / `regressed` / `baseline-broken` /
      `fixed-baseline`. A `baseline-broken` result does not block the AI; a `regressed` result triggers a
      retry within the attempt budget (failing verify evidence injected via `RETRY_FEEDBACK_SECTION`); budget
      exhaustion transitions task to `blocked`. When `Repository.verifyGates` is present and non-empty,
      post-task verify runs only diff-scoped gates (pre-task always runs all gates). `Repository.verifyTimeout`
      is forwarded as `timeoutMs` to both calls; absent → 5-min runner default.
- [x] **Branch management** — `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
      per-task preflight verifies the right branch is checked out.
- [x] **Resume of aborted runs** — tasks left in `in_progress` from a prior crash stay `in_progress` and
      are queued FIRST on relaunch; `start-attempt` settles the leftover `running` attempt as `aborted`
      (cause `process-crash`, kept in `attempts[]`) then opens a fresh attempt. Manual `task unblock` is
      the only reset-to-`todo` path. The resume-from-aborted header surfaces in the TUI as
      "attempt N · resumed from aborted M at HH:MM (cause)" using the `AbortCause` discriminated union.
- [x] **Rate-limit retry** — adapter-side escalating backoff on `RateLimitError`; capped by
      `settings.harness.rateLimitRetries`.
- [x] **Idle-stdout watchdog** — wedged headless AI children get killed after a configurable idle threshold.
- [x] **EventBus emissions** — chain runner emits `ChainStarted` → per-step `ChainStepStarted/Completed/Failed`
      → `ChainCompleted/Failed/Aborted`; per-task `TaskAttemptStarted` / `TaskAttemptEvaluated` /
      `TaskRoundStarted` (carrying `roundN`, `attemptN`, `totalCap`).
- [x] **Plateau predicate** — consecutive evaluator rounds flagging the same failed-dimension set exit the
      loop with a plateau warning after `settings.harness.plateauThreshold` (2–5, default 3) rounds.
      A critique-Jaccard shift or a genuine work-product (changed-files-hash) change exempts a round; a
      commit-subject-only reword of an unchanged work-product no longer softens the plateau.
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

- [x] **Distinct chain** — `review` flow lives in `application/flows/review/`; not embedded inside `implement`.
- [x] **Free-form feedback** — multi-line editor prompt; empty submission terminates the loop.
- [x] **AI session resumes via session id** — the harness reads back the per-task `session-id.txt` file from
      `<sprintDir>/implement/<unit>/rounds/<N>/generator/session-id.txt` and resumes the relevant task's session.
- [ ] **EventBus emits `FeedbackRoundApplied`** per round. _Not yet wired: the `FeedbackRoundAppliedEvent`
      type is defined in `events.ts` and in the `AppEvent` union, but `review-round.ts` never publishes it
      (only `ai-signal` events are emitted)._

## AI provider integration

- [x] **Three providers** — `claude-code`, `github-copilot`, `openai-codex`, each with its own adapter under
      `integration/ai/providers/<tool>/`. Sibling-isolated; cross-tool sharing through `providers/_engine/`.
- [x] **File-based contract** — providers write `signals.json` and `session-id.txt` files per spawn (both under
      `rounds/<N>/<role>/`); the harness reads them post-spawn. No stdout parsing for signals or session IDs.
- [x] **Idle-stdout watchdog** — wedged children get reaped.
- [x] **Escalating backoff** — rate-limit retries use a fixed escalating wait schedule (1min → 5min → 30min →
      2h, last entry repeating) in `rate-limit-backoff.ts` (`integration/ai/providers/_engine/`).
- [x] **Interactive variant** — `InteractiveAiProvider` hands over the terminal (alt-screen swap to the AI's
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
- [x] **Provider-native context file** — the `readiness` flow fans out across every uniquely referenced
      provider in `settings.ai`, writing one native context file per distinct provider: `CLAUDE.md`
      (claude-code), `.github/copilot-instructions.md` (github-copilot), `AGENTS.md` (openai-codex). A
      single-provider config produces exactly one file; mixed configs produce one per distinct provider.

## Per-flow model selection

- [x] **Settings shape** — `settings.ai` is a flat record: an optional global `ai.effort` plus per-flow rows
      `ai.{refine,plan,readiness,ideate,createPr}` (each `{ provider, model, effort? }`) and a nested
      `ai.implement.{generator,evaluator}` pair. `detect-scripts`/`detect-skills` reuse the `readiness` row and
      `review` reuses the `implement` row — there is no `settings.ai.models` sub-object. Each flow reads its own
      provider/model/effort.
- [x] **Provider × model validation** — a row's `model` must be either in the configured provider's catalog
      (`src/domain/value/settings-models/<provider>.ts`) or any non-empty trimmed custom string; the per-flow
      `effort` validates against the provider's native vocabulary. Custom (off-catalog) model ids parse at load
      time and are rejected by the provider CLI at spawn time, not by the persistence schema.

## Doctor

- [x] **`ralphctl doctor`** runs every check; per-check rows with status (`pass` / `warn` / `fail`); an
      aggregate result card at the bottom.
- [x] **TUI doctor hotkey** (`!`) opens the same view from anywhere.
- [ ] **Onboarding-status check** reports per-(project, repo) onboarding state. _Not implemented: the doctor
      probe list has no per-(project, repo) onboarding-state probe._

## Settings

- [ ] **Schema-driven settings panel** — TUI rows are built from a hand-authored section/field model in
      `settings-view-model.ts` (not by introspecting `SettingsSchema`); each field declares its prompt `kind`
      (`select` / `text` / `preset` / `map-add` / `map-entry`) explicitly. Edits save immediately via the
      `settings-set` flow → `SettingsRepository.save()`. _Left unticked pending a decision on whether
      schema-introspection is still a goal; the save-immediately half is fully wired._
- [x] **CLI parity** — `ralphctl settings show` prints the current settings; `ralphctl settings set <key> <value>`
      sets a single key (plus `settings apply-preset`).
- [ ] **Schema validation on read** — corrupt or v0.6.x-shaped `settings.json` files surface a typed
      `ParseError` (subCode `schema-mismatch`) from the persistence boundary. _The `ralphctl settings` re-run
      hint is not attached today — `ParseError.hint` is left unset on settings-parse failures._
- [x] **`schemaVersion`** — written on every save; migration path runs before validation if the on-disk shape
      changes in a future version.

## CLI surface

- [x] **Surface is deliberately smaller than the pre-TUI CLI** — interactive flows (refine / plan / ideate /
      implement / readiness / create-sprint) stay TUI-only. The CLI exposes only inspection commands +
      one-shot operations: `doctor`, `completion <shell>`, `export-context`, `export-requirements`, `create-pr`,
      `settings {show,set,apply-preset}`, `project {list,show,remove}`,
      `sprint {list,show,set-current,activate,close,remove,progress}`,
      `ticket {list,show,add,remove}`, `task {list,show,unblock}`,
      `runs {list,prune}`.
- [ ] **Each one-shot command** has a `tests/e2e/cli/<name>.test.ts` pinning the success-path stdout.
      _Mostly done; `export-requirements` and `create-pr` are covered only at the flow level, not by a
      stdout-pinning `tests/e2e/cli/` test._
- [ ] **Exit codes** — `0` success, `1` error. _`130`-on-interrupt is not wired: there is no SIGINT handler
      that sets `process.exitCode = 130`._

## TUI

See [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) for tokens, components, view patterns, and copy rules.

- [x] **Alt-screen takeover** — bare `ralphctl` enters the alt-screen buffer + hides cursor via
      `createInkHost({ alternateScreen: true })`; restored on unmount and signal-safely on
      `exit` / `SIGINT` / `SIGTERM` / `SIGHUP` / `uncaughtException` through Ink's bundled `signal-exit`.
- [x] **Non-TTY fallback** — a non-TTY stdin/stdout (pipe / CI / cron) bails at the top of `launchTui`
      (`launch.ts`) with a one-line stderr hint + exit 1 before the Ink mount, rather than dumping Ink's
      raw-mode stack trace. (The guard checks `process.stdin.isTTY` / `process.stdout.isTTY` directly; `CI` /
      `RALPHCTL_NO_TUI` only gate implicit interactive prompting inside the `implement` flow.)
- [x] **Persistent banner** — `<Banner />` renders on every view via `<ViewShell />`. Quote stabilises at
      module load.
- [x] **Help overlay** — `?` opens `<HelpOverlay />`; rendered from the centralised keyboard map.
- [x] **Centralised keyboard map** — one table; adding a binding is one edit.
- [x] **Multi-flow nav** — Tab / Shift+Tab cycle running flow sessions; `Ctrl+1..9` direct-jump;
      `SessionsView` lists every runner with status + age. Both chords are gated off while a prompt
      or overlay is mounted.
- [x] **Live execute view** — `ExecuteView` subscribes to the EventBus; renders `StepTrace` + `TasksPanel` +
      `RecentEventsTail`. Late attach is lossless (synthetic replay).
- [ ] **Prompt transcript** — resolved prompts render dim above the live prompt; history clears when the
      prompt queue idles past `SEQUENCE_IDLE_MS`. _Not implemented: `prompt-host.tsx` renders only the head
      prompt; there is no resolved-prompt transcript and no `SEQUENCE_IDLE_MS` constant._
- [x] **Form retry loop** — create-project / add-ticket / add-repository views retry on validation
      errors (an `error` step with esc-to-go-back) instead of popping back to home.
- [x] **Windowed-list primitive** — all long, scrollable, homogeneous lists mount through
      `windowed-list.tsx` (`computeListWindow` / `useListWindow` / `WindowedList` / `OverflowRow`). Id-based
      cursor survives reorder/eviction. `↑/↓` primary, `j`/`k` alias, `PgUp`/`PgDn` page, `Home`/`End` jump.
      `▴/▾` overflow cues. A view that owns its list cursor passes `suppressScrollArrows` to its `ViewShell`
      (translated to `ScrollRegion`'s internal `suppressArrows`) so `↑/↓` / `PgUp`/`PgDn` aren't double-handled.
- [x] **Responsive Execute view** — three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail
      at `md` (100–139), single-column below `md`. Rail grows fluidly 36→56 cols at `xl`+ via
      `resolveRailWidth`. `StepTrace` renders `Element.label` when present; long labels mid-truncated to
      fit the rail column budget.
- [x] **TUI hotkeys** — `b` banner compact ↔ full toggle; `g` progress overlay (reads `progress.md` on
      demand); `y` yank active-task summary to clipboard; `P` cross-project project picker; `S`
      cross-project sprint picker (with `t` toggle-scope and `f` hide-done inside the picker); `j`/`k`
      task-card navigation; `e` expand done-criteria for active card; `c` cancel-scope picker (attempt vs
      whole flow).
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

- [x] **Two-stage build** — `tsup` compiles `dist/cli.mjs`; `tsx scripts/build-assets.ts` copies prompts +
      bundled skills into `dist/{prompts,skills}/` and writes `dist/manifest.json`.
- [x] **Dual-mode loading** — `FsTemplateLoader` and `bundledSkillSource` detect bundled mode via
      `import.meta.url`. Dev reads from `src/`; bundled reads from `dist/`.
- [ ] **Asset verification** — a missing template / skill surfaces a generic `StorageError` at load time
      (`fs-template-loader.ts` / `bundled/source.ts`). _Not implemented: `dist/manifest.json` is write-only —
      there is no startup integrity check against it and no repair hint._
- [x] **CI tarball smoke** — `pnpm pack` + `npm install` into a tmp dir + `ralphctl --version` from arbitrary
      cwd exits 0 and prints the version from `package.json`.
- [x] **`--provenance`** flag on npm publish.

## Data migration & versioning

- [x] **Auto-migration on startup** — a `data/.ralphctl-data-version.json` stamp (`DATA_VERSION` in
      `integration/persistence/data-migration/version-marker.ts`) tracks migration state; pending migrations
      run automatically before first use (`data-migration/apply.ts`, with a `dry-run.ts` preview).
- [x] **One-time consent splash + backup** — the TUI migration gate (`ui/tui/migration/migration-gate.tsx`)
      shows a one-time consent splash and backs up `data/` before renaming existing entries to the slug
      layout. `config/` is never touched.
- [x] **Slug-rename with legacy tolerance** — on-disk entries use `<id>--<slug>` (`NAME_SEPARATOR` in
      `integration/persistence/storage.ts`); resolvers still read the legacy bare `<id>` form so un-migrated
      data loads.
- [x] **Best-effort settings migration on read** — `_engine/run-migrations.ts` upgrades on-disk settings
      records in place (unknown fields preserved); the canonical shape is rewritten on the next `save()`.
- [x] **Legacy v0.6.x guard** — `bootstrap/legacy-layout-detector.ts` detects a pre-0.7 `~/.ralphctl/`
      layout at boot, refuses to start, and prints the exact backup command. Bypass with
      `RALPHCTL_SKIP_LEGACY_CHECK`; no data is touched.

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
