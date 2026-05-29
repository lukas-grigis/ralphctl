# Changelog

All notable changes to RalphCTL will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Process spawning works on Windows across every flow.** All external-CLI spawns
  (`claude` / `codex` / `gh` / `glab` / `git`, headless and interactive) now route through a
  single `cross-spawn`-backed primitive (`integration/io/cross-platform-spawn.ts`). This
  resolves the npm/winget `.cmd` shims that a bare `child_process.spawn` cannot launch on
  Node 24 Windows, and escapes arguments correctly without a shell — so paths containing
  spaces (`C:\Users\First Last\repo`) and prompts containing `& | % "` no longer break the
  spawn. Replaces the earlier interactive-only `shell: true` workaround, which mis-quoted such
  arguments. The `doctor` probes (`run-command`) and the setup/verify-script runner are covered
  by the same fix. Fixes the immediate `refine` crash (`session exited with code 1`) and the
  previously-unreachable `implement` / `create-pr` failures on Windows.
- **Copilot provider probes the correct binary.** `detect-cli` now maps `github-copilot` to the
  standalone GitHub Copilot CLI (`copilot`) — the binary the provider adapter actually spawns —
  instead of `gh` (the separate SCM dependency). The launch fail-fast, fresh-install detection,
  apply-preset warnings, and install guidance (`npm install -g @github/copilot` / `brew install
copilot-cli` / `winget install GitHub.Copilot`) now reference the standalone CLI rather than the
  deprecated `gh-copilot` extension, so a Copilot user with `gh` but not `copilot` is no longer
  passed by the pre-flight check and then failed at spawn. The duplicated `PROVIDER_BINARY` map in
  the `doctor` flow is unified onto the single source of truth in `detect-cli`.

## [0.8.5] - 2026-05-29

### Fixed

- **CLI shim resolution on Windows.** `detect-cli` now resolves `.cmd` and `.ps1` wrapper shims
  so AI flows (`claude`, `gh`, `codex`) launch correctly on Windows (#174).

## [0.8.4] - 2026-05-28

### Added

- **Per-line debug events from the headless AI adapters.** Claude / Codex / Copilot headless
  adapters each publish one `debug`-level log event per recognised stream line — surfacing tool
  calls and intermediate assistant text during a long-running implement turn when
  `RALPHCTL_LOG_LEVEL=debug`. Nothing appears at the default log level; message text is capped at
  120 chars (#153).
- **Per-provider conventions in the readiness flow.** Readiness now selects one of three
  conventions partials by provider — `CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md` —
  and embeds it before the output contract, so the AI matches each target file's tone and structure
  instead of writing every native context file like a `CLAUDE.md` (#170, closes #159).
- **TUI resolves an initial selection at launch.** Defaults to the first project when nothing is
  persisted, validates a persisted sprint against its project (seeding the most-recent sprint when
  the stored one is invalid), and only persists selection changes made after mount — fresh installs
  land on a usable project/sprint instead of an empty selection (#172).

### Fixed

- **`useTaskRoundTracker` memory is now bounded.** The hook caps retention at
  `TASK_ROUND_CAP = 500` via the same delete-then-set-then-evict LRU reducer used by the
  token-usage hook, bringing it in line with the other bounded TUI bus-subscriber hooks so a
  long-running sprint can no longer grow the map without limit (#158).
- **Sprints list now sorts newest-first.** `SprintsView` reverses the ascending-UUIDv7 repository
  order for both the project-scoped and all-sprints branches, matching the home view and the
  cross-project picker (#172).

### Changed

- **Claude catalog moves to Opus 4.8.** `claude-opus-4-7` is replaced by `claude-opus-4-8` as the
  Claude top-tier model — catalog, context-window table, defaults, presets (`mixed` / `claude-only`),
  and the escalation ladder (`claude-sonnet-4-6` → `claude-opus-4-8`) all point at 4.8.
  Existing settings files pinning `claude-opus-4-7` on a `claude-code` row are silently migrated to
  `claude-opus-4-8` at load time (no `schemaVersion` bump; rewritten on next save) — no manual
  action needed.
- **Cross-provider audit and rewrite of every prompt template.** Templates now open with a `<role>`
  block instead of Markdown H1s, use provider-agnostic vocabulary (no `Bash` / `Edit` / `WebFetch` /
  `AskUserQuestion` tool-name leaks), and follow a `<role> → <goal> → <success_criteria> → <inputs>
→ <constraints> → <output_contract>` skeleton. The `evaluate` template gains a pinned dimensional
  rubric plus calibration examples; refine signal-field names, implement `expectedSignals`, and
  review follow-up grading were realigned with the signal contract, with parity tests locking the
  vocabulary. Bundled templates ship the rewrites to downstream consumers (#157).
- **Prompt contract section no longer leaks Claude tool names.** `renderContractSection` drops the
  Claude-specific `Write` tool name and the incorrect cwd claim (wrong for refine / plan / ideate /
  readiness / create-pr), replaced with provider-agnostic absolute-path guidance (#170, closes #160).
- **Flat field cursor in the project-detail view.** The "Edit which field?" modal is replaced with a
  flat ↑/↓-navigable field list (project `displayName`, then each repo's `name` / `setupScript` /
  `verifyScript`); `e` and Enter open the focused field's editor directly, per-repo actions derive
  their target repo from the focused row, and row-level highlighting matches the settings view
  (#161).

## [0.8.3] - 2026-05-28

### Added

- **Planner task order is now topologically sorted at parse time.** `parseTaskList`
  reorders emitted tasks via Kahn's algorithm using each task's `blockedBy` edges,
  and rejects the list if a dependency cycle is detected at parse — surfacing the
  offending cycle ids instead of trusting the planner's emission order silently.
  Implement still launches tasks in `Task.order` (planner-assigned `i + 1`), so the
  net effect is that out-of-order planner output gets straightened before it's
  persisted (#167).
- **`ai.createPr` settings row.** The optional `create-pr --ai` step now has its
  own `{ provider, model, effort? }` settings row instead of borrowing `ai.refine`.
  Settings files written by ralphctl ≤ 0.8.2 are silently promoted on load — the
  missing row is seeded from `ai.refine` and the canonical shape lands on the next
  save. No `schemaVersion` bump and no user-facing notice (#167).

### Fixed

- **`AbortError` now propagates cleanly through every chain primitive.** Locked in
  by tests against `leaf` / `sequential` / `loop` / `guard` so user-initiated
  cancellation (Ctrl+C, the TUI abort hotkey) is never swallowed by a guard or
  fallback wrapper (#167).

### Changed

- **Hardened JSON parsing and atomic-write call sites** across persistence
  adapters — typed schema declarations replace `as unknown as` casts in repository
  serializers, and a single helper centralizes the signal-array Zod brand cast so
  the contract surface stays type-safe at the boundary (#167).
- **Architecture clean-up: god-files split, AI-provider ports moved to `_engine/`.**
  `task` entity, `execute-view`, `sprint-detail-view`, `settings-view`,
  `tasks-panel`, `pick-sprint`, `home`, and `add-ticket` views were each split
  into focused sibling modules; `AiSession.prompt` was tightened and remaining
  `sessionId` TODOs resolved; provider port-shaped interfaces consolidated under
  `src/integration/ai/providers/_engine/` per the sibling-isolation rule. No
  user-visible behaviour change — included for downstream contributors who pin
  internal modules (#167).

## [0.8.2] - 2026-05-26

### Added

- **Per-spawn AI attribution sidecar.** Every AI spawn (refine, plan, implement
  generator + evaluator, readiness, ideate) now writes `meta.json` beside
  `signals.json` capturing `provider` / `model` / `effort` / `timestamp` so
  historical attribution survives later `settings.json` mutation and
  signals-missing crashes. Implement additionally stamps per-round
  `rounds/<N>/<role>/meta.json` with `attempt` / `round` for full
  generator-vs-evaluator provenance. Forward-only — pre-existing sprint dirs
  are not back-filled.
- **Per-launch AI customize picker.** Every AI-driven flow (refine / plan /
  implement / readiness / ideate) now offers a per-launch provider / model /
  effort override, so you can target a different backend for a single run
  without changing saved settings (#151).
- **Per-card expand/collapse in sprint detail.** Ticket and task cards expand
  and collapse individually, keyed by a stable id so the state survives
  re-renders (#149).
- **Scrollable description in the add-ticket Review step** — long ticket bodies
  scroll inside the review pane instead of overflowing the terminal (#150).

### Changed

- **Implement skips pre-task-verify when the carried baseline is green.**
  Post-verify outcome (`cwd` + `success`) is carried on
  `ctx.priorPostVerifyOutcome`; pre-task-verify short-circuits when it matches
  the current `cwd` and `git status` is clean. Cuts `verifyScript` runs from
  2N to N+1 on happy-path sprints (~50% wallclock on 4+ tasks). Dirty trees
  or git probe errors fall through to the real verify path unchanged.
- **Section-tabbed Settings view.** Settings is reorganised into a tabbed
  section strip (`←/→` to switch, `↑/↓` to navigate) with a catalog-only model
  field per flow, keeping each section's cursor path short. Settings labels now
  render in full (no more truncation) and the per-section cards size to their
  widest label (#151).

### Fixed

- **Implement: gen-eval `AiSession` now sets `outputDir`** so codex's
  `workspace-write` sandbox accepts the per-round `signals.json` Write call.
  Without this, the evaluator failed with `signals-missing` on every round.
- **A non-Claude generator/evaluator turn failure no longer aborts the whole
  implement run.** A missing / malformed / schema-invalid `signals.json` now
  blocks just that task (surfaced and re-runnable on the next run) instead of
  tearing down the entire run — most visible with non-Claude evaluators, which
  trip the strict contract more often. `AbortError` / `RateLimitError` still
  propagate. The evaluator's recoverable path routes to a self-block, so an
  ungraded change is never silently marked done (#165).
- **codex session-id capture** — codex-cli 0.130.0 reports the id as
  `thread_id` on its `thread.started` record, not `session_id`; the adapter now
  reads it, restoring cross-round `--resume` continuity and token-usage
  telemetry for codex (#165).
- **Refine no longer loses a refinement to one malformed signal.** A single
  malformed auxiliary signal (e.g. a `decision` emitted with the wrong field)
  used to fail the whole contract and silently discard the refined ticket.
  Refine now drops only the bad auxiliary signal, keeps the valid
  `refined-ticket`, and surfaces an actionable message when the AI session
  exits before writing `signals.json` (#165).
- **Execute view scroll** — `↑/↓` now scrolls the live implement view again;
  the scroll region was reading a stale content height and never engaged on
  dynamically growing content (#165).
- **Plugged a React Hook desync in the execute view** and wired the
  `react-hooks` lint rule to catch the class.

## [0.8.1] - 2026-05-25

### Added

- **Implement gen/eval split.** `settings.ai.implement` is now a nested
  `{ generator, evaluator }` pair — each role carries its own
  `{ provider, model, effort? }` row so the produce-side and the score-side can
  run on different providers / models / effort levels. Default: generator
  `claude-code` / `claude-opus-4-7`, evaluator `openai-codex` / `gpt-5.5`.
  Legacy flat `ai.implement` rows from ≤ 0.8.0 are silently promoted on read
  (no schema bump, no user notice); the next `save()` rewrites in the canonical
  nested shape.
- **Plateau-driven generator-model escalation.** Two new opt-in
  `settings.harness` knobs let the gen-eval loop retry a plateaued task on a
  stronger generator model instead of immediately blocking:
  `escalateOnPlateau` (default `false`) and `escalationMap` (user overrides
  merged over the built-in `DEFAULT_ESCALATION_MAP` covering the common
  in-provider rungs). Escalation is generator-only, fires at most once per
  task, and stamps `Task.escalatedFromModel` / `escalatedToModel` on first use.
- **Broken-baseline operator gate.** When the pre-task verify reveals a
  broken baseline, implement now prompts the operator before launching the AI
  on the task — so a known-bad baseline can be acknowledged, deferred, or
  fixed manually instead of silently being attributed away.
- **Provider availability gating across all four surfaces.** Settings TUI
  picker, settings TUI submission, CLI `settings set ai.<flow>.provider`, and
  launch preflight now uniformly refuse providers whose CLI is missing on
  PATH. The picker labels missing providers as `(not installed)` and surfaces
  the install command in the footer; CLI / flow rejections embed the exact
  dotted-path key and the install command in the error. `PROVIDER_INSTALL_HINT`
  - `renderProviderInstallGuidance` in `detect-cli` are the single source for
    install copy.

### Fixed

- **TUI scroll-bleed in prompts**, plus the inline sprint-detail toggle and
  the active-task collapse toggle no longer redraw outside their region.
- **Providers — `signals.json` recovery on watchdog SIGTERM / code 143.**
  A wedged headless AI child that the idle-stdout watchdog kills now has its
  partial `signals.json` surfaced to the harness instead of being dropped on
  the floor.
- **Runtime — plugged three `runner.subscribe()` leaks** that accumulated
  long-lived listeners across multi-flow TUI navigation.
- **Setup/verify logs no longer contain ANSI colour codes** — the harness
  sets `NO_COLOR=1` on the shell-script-runner spawn env and the
  detect-scripts prompt suggests JVM-specific flags
  (`mvn -B`, `gradle --console=plain`, `sbt -no-colors`) which don't respect
  `NO_COLOR`.

## [0.8.0] - 2026-05-24

### Notes

The 0.7.x line shipped a lot of structural change in a short window — an
on-disk rewrite, a settings-schema refactor, a domain rename, and a
signal-pipeline migration, across four releases in six days. That was a lot to
keep up with, and we're sorry for the churn. Thank you for sticking with
ralphctl through it.

**Upgrading:** install the latest version, re-run `ralphctl settings
apply-preset <name>` (or reconfigure manually), re-register your projects if
needed, and go. We don't try to support multiple versions in parallel —
latest is what's supported. If your old `~/.ralphctl/` data doesn't load
cleanly, back it up (`mv ~/.ralphctl ~/.ralphctl.bak`) and start fresh; the
backup keeps your ticket bodies and plan output around for reference.
Contributions and bug reports very welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

### Breaking

- (none in this section — see _Changed_ for field renames and schema reshapes that load older
  files via best-effort migration on read.)

### Added

- **Per-flow AI settings + four-preset bootstrap (`mixed`, `claude-only`, `copilot-only`, `codex-only`).**
  Apply via `ralphctl settings apply-preset <name>` from the CLI or the TUI settings view. A preset stamps
  the entire `ai` section in one shot; subsequent per-key edits via
  `ralphctl settings set ai.<flow>.<field> <value>` stick.

- **Fail-fast PATH probe on every AI-spawning flow.** The launcher probes for the configured CLI
  (`claude` / `gh` / `codex`) at launch and exits with a clear error naming the binary, the flow, and
  the offending `settings.ai.<flow>.provider` key when the binary is absent. First-run auto-seeds a preset
  based on what's installed.

- **Readiness fan-out across every referenced provider.** One native context file per provider
  (claude-code → `CLAUDE.md`, github-copilot → `.github/copilot-instructions.md`, openai-codex →
  `AGENTS.md`). Single-provider configurations produce exactly one file; mixed configurations produce one
  per distinct provider.

- **`ralphctl snapshot [--sprint <id>]` CLI command.** Writes a single-frame text digest of the active
  sprint's current state to stdout (no Ink mount) — header, status, tasks table, active-task block,
  recent-signals tail. Resolves sprint from `--sprint`, then from the pinned selection; exits 1 with a hint
  when neither is set.

- **`ralphctl sprint regenerate-progress <id>` CLI subcommand.** Rebuilds `progress.md` from disk state
  (`chain.log` + `decisions.log` + `sprint.json` / `tasks.json` / `execution.json`) without running
  implement. Operator escape hatch when `progress.md` is corrupt (e.g. a runaway `<decision>` tag before
  the parser-level defence landed) or entities were edited by hand.

- **Three-column Implement layout with responsive breakpoints.** At ≥180 cols the execute view splits into a
  fixed-width rail (24 cols), a flex Tasks stream, and a fixed context column (28 cols). At 140–179 cols the
  context column drops; below 140 cols the existing single-column stack applies, capped at 4 Flow Steps rows
  below 100 cols. Signal bodies now ellide at actual rendered width instead of hard-coded 60/80-char clips.

- **Tiered StatusBanner replaces single-purpose `RateLimitBanner`.** A `BannerShowEvent` / `BannerClearEvent`
  pair on the AppEvent bus lets any subsystem surface state through one generic strip. Banners stack ordered
  error → warn → info; surplus past 3 collapses to `+N more`; `d` dismisses the topmost. Emitters: rate-limit
  backoff (info), idle-stdout watchdog (warn), setup-script failure (error), red-baseline pre-task check (warn),
  lock-acquisition exhaustion (warn).

- **Banner full ↔ compact toggle on `b`.** A global `b` hotkey flips the banner between full and compact for
  the session. Implement view defaults to compact so long runs preserve vertical real estate.

- **Sprint-level `decisions.log` + prompt-driven decision capture.** A new `_partials/decisions.md` prompt
  section instructs the AI to emit `<decision>` tags for non-obvious architectural choices. A
  `decisions-log-sink` appends one line per decision to `<sprintDir>/decisions.log` (atomic serial drain);
  `projectSprintState` merges decisions-log entries into the `## Decisions` section of `progress.md`.

- **Per-task `#### Changes` / `#### Learnings` / `#### Notes` sub-sections in `progress.md`.** The
  `state-projection.ts` miner reads `harness-signal` entries from `chain.log`, groups them by `taskId`,
  and exposes them as `TaskProjection.{changes, learnings, notes}`. `render-progress-markdown.ts`
  renders these under each `### Task N — <name>` section.

- **`HarnessSignalEvent` AppEvent variant.** A new `harness-signal` event on the `AppEvent` union carries
  `signalKind` (`'change' | 'learning' | 'note'`), optional `taskId`, and `text`. Published by the signal
  adapter whenever the AI emits a `<change>`, `<learning>`, or `<note>` tag during an in-flight task, so
  `<sprintDir>/chain.log` retains a machine-readable record of the per-task narrative that `progress.md`
  can reconstruct on every snapshot regenerate.

- **Machine-readable JSON block at the bottom of `progress.md`.** A `<!-- machine:begin -->` / `<!-- machine:end -->`
  fenced JSON payload (`sprintId`, `status`, task array with `id`, `name`, `status`, `attempts`,
  `blockReason?`, `lastVerdict?`, `commitSha?`) closes every generated `progress.md` for tooling that
  needs to parse sprint state without loading the full entity layer.

- **`progress.md` snapshot renderer replaces streaming sink.** `renderProgressMarkdown` turns the SprintState
  projection into a Markdown bootstrap document targeting a fresh AI session — sections for status, branch/PR,
  tickets, tasks, blockers, stale tasks, dependency cycles, decisions, and recent runs. Empty sections are
  omitted. Snapshot regenerates at three trigger points: sprint start, post-settle, post-review transition.
  Legacy streaming `progress-file-sink` and `flush-progress-sink` leaf removed.

- **SprintState projection as single TUI/progress.md surface.** A pure `projectSprintState` function projects
  Sprint + SprintExecution + Task[] + chain.log entries into a normalised view model used by both the progress
  renderer and TUI panels. Encodes effective-status synthesis (active-but-all-blocked → `'blocked'`), stale-task
  detection (24 h threshold), dependency-cycle detection with orphan synthesis, run-boundary grouping, and median
  attempt-duration for ETA.

- **Global `g` overlay reads `progress.md` from disk.** Pressing `g` (when a sprint is loaded) opens a
  read-only, scrollable Ink overlay mirroring `<sprintDir>/progress.md`. Esc or `g` again dismisses. The file
  is read fresh on each open so it always reflects the last snapshot.

- **Per-round `outcome.md` digest.** After every settle-attempt leaf the chain writes
  `<sprintDir>/implement/<task-id>/rounds/<N>/outcome.md` — verdict, evaluator dimensions, critique (when not
  passed), session IDs, commit SHA, duration, and a one-sentence synthesis paragraph. Crash mid-spawn still
  leaves the file from the triggering round. Best-effort write; failures are logged and swallowed.

- **Per-round generator + evaluator prompts persisted to disk.** `writeRoundPrompt` writes
  `<workspaceRoot>/rounds/<N>/<role>/prompt.md` atomically before each AI spawn, so a crash mid-spawn still
  leaves the prompt that triggered it on disk.

- **Pre/post check-script audit with attribution.** `CheckRun` / `Attribution` types on `Attempt` record
  baseline (pre) and verification (post) check outcomes per round, surviving resume. `preTaskCheckLeaf` captures
  baseline state before the generator; a red baseline stamps `baselineBroken: true` and warns but never blocks.
  `postTaskCheckLeaf` computes attribution from pre+post outcomes and blocks the task on `regressed` (pre-green,
  post-red). `baseline-broken` preserves the AI's verdict.

- **Baseline-health card + chip in context column.** `BaselineHealthCard` surfaces Setup / Check (pre) / Check
  (post) rows plus an attribution count summary (clean / regressed / fixed-baseline / baseline-broken). A
  companion `BaselineHealthChip` shows a single-line status above the active-task header; tier synthesis: red on
  regressions or failed setup, amber on broken-baseline attempts or stale checks, green otherwise.

- **Deterministic setup-script audit with spawn-error attribution.** `SetupRun` now carries `command`,
  `exitCode`, `durationMs`, stdout/stderr tails (capped at 4 KB), and `outcome` (`success | failed |
spawn-error | skipped`). The runner appends every attempt without upsert. Spawn-time errors (ENOENT, permission
  denied) record `exitCode: -1` so operators can distinguish "ran and failed" from "could not run." Legacy
  two-field rows migrate in-place on read.

- **`task-round-started` event + `useTaskRoundTracker` hook.** The generator leaf emits `TaskRoundStartedEvent`
  before the AI call so TUI subscribers see the round boundary immediately. A new monotonic hook reads it;
  the execute-view drops the trace-counting ref hack and survives chain.trace ring eviction without counting
  leaves.

- **Resume-from-aborted context on Attempt.** `AbortCause` discriminated union
  (`user-cancel | sigterm | watchdog-killed | rate-limit-exhausted | process-crash | unknown`) +
  `RecoveryContext { fromAttemptN, cause, abortedAt }` are stamped on the `RunningAttempt`. The TUI surfaces
  `↳ attempt N · resumed from aborted M at HH:MM (CAUSE)` in the active-task header before the first leaf runs.

- **`chain.log` run boundaries.** Each chain run is bracketed by human-readable delimiter lines
  (`=== chain-run <chainId> <flow> started <iso> ===` / `=== chain-run … <outcome> … ===`).
  NDJSON consumers skip lines not starting with `{`; legacy boundary-less logs still parse.

- **`sessionId` file persisted next to `signals.json` per spawn.** All three providers (Claude / Copilot /
  Codex) write `<signals-dir>/sessionId` atomically after a clean-termination spawn, closing the gap between
  the documented file-based AI provider contract and reality.

- **Token / attention-budget card.** A new `TokenBudgetCard` subscribes to `TokenUsageEvent` and renders
  input/output tokens, cache-hit (when reported), and a tiered (green/amber/red) context-window progress bar.
  Providers emit one `TokenUsageEvent` per clean-exit spawn; Claude reports all four counter types; Copilot /
  Codex emit what their CLI surfaces.

- **ETA estimate from median round duration in attempt header.** `TasksPanel` derives
  `medianRoundDurationMs × (max − currentRound)` for the active task and renders `· ~Xm Ys remaining` when a
  median is known, `· no ETA yet` on the first round of the first task.

- **Done-criteria surface + per-criterion verdict mapping.** `TasksPanel` renders a collapsed 3-line criteria
  summary per non-pending task; `e` toggles the active task's full bullet list. Per-criterion verdict mapping
  pairs criterion bullets with evaluator dimensions positionally when counts match; falls back to the 4-dim
  summary otherwise.

- **`y` hotkey copies active-task summary to clipboard.** `createCopyToClipboard` shells out to `pbcopy` /
  `wl-copy` / `xclip` / `clip.exe`. A 2-second banner confirms success or reports the error; the hotkey is
  best-effort and never throws into the TUI.

- **Collapsed-by-default task cards with `j`/`k` expansion.** Non-active task cards collapse to a single-line
  summary (`<icon> <name> · <status> · <attempts>× · <sha?>`). The active task auto-expands. `j`/`k`/arrows
  navigate; Enter/Space expand a focused card; Esc collapses a manually-expanded card (active card exempt).
  The cursor sticks to its row when new signals arrive and the slice shifts.

- **Idle-state ticker showing last note signals.** When the active task's latest signal is older than 10 s, a
  muted ticker line surfaces the last 1–2 note/learning signal bodies. The ticker vanishes the moment any new
  signal lands.

- **Empty + first-run states for Tasks panel.** Zero-task render shows `Tasks panel empty · Run plan to
generate tasks`; on the first round before any signal fires, the active-task spinner shows a
  `waiting for first attempt…` hint.

- **Cancel hotkey opens scope picker.** Pressing `c` on a running Implement view opens `CancelScopeOverlay`
  instead of aborting immediately. Option `1` cancels just the current attempt; option `2` marks the active
  task `blocked` with reason `'user cancel'` and aborts the chain. The overlay shows wall-clock waste time
  and the count of remaining queued tasks.

- **Fixture-gated per-dimension evaluator-failure panel.** `EvaluatorFailurePanel` renders per-dimension
  verdicts, critique excerpts, and a "next round will receive this critique" annotation. Gated behind
  `settings.developer.showEvaluatorFailureUI` (default `false`); promoted once validated.

- **Plateau predicate refined with score-delta + commit-progress exemptions.** `computePlateauVerdict` adds
  three exemptions before declaring a plateau: score improvement (≥1 on a same-still-failed dimension),
  critique-prose shift (trigram Jaccard < 0.5), and proposed-commit-subject change (softened to a non-exiting
  warning). `settings.harness.plateauThreshold` (2–5, default 2) is configurable.

- **Signal legend replaced by inline kinds bar + help overlay entry.** The static 6-row `SignalLegend` is gone;
  a one-row `InlineKindsBar` labels only the signal kinds that have actually appeared in the run. A Signals
  reference section in the help overlay (`?`) auto-populates from the same colour-map. `NO_COLOR` glyph backups
  (`change → +`, `learning → ~`, `decision → ◇`, `verified → ★`, `blocked → △`, `commit → ■`, `note → •`)
  ensure signal-kind discrimination survives monochrome terminals.

- **Context-compacted signal type + TUI marker.** `ContextCompactedSignal` is a first-class lifecycle event
  for the provider's auto-compaction boundary, rendered as a dedented separator line in the signal stream using
  the muted colour token.

- **Terminal bell + OS notifications on attention events.** A new `NotificationDispatcher` port + OS-backed
  adapter fires for: setup-script failure, chain abort, rate-limit pause ≥ 60 s, and red-baseline warn logs.
  Darwin shells out to `osascript`; Linux probes `notify-send`; others bell-only. Controlled by a new
  `settings.ui.notifications.enabled` flag (default `true`).

- **Commit row body + `Closes` trailer expansion.** A `commit-message` signal row is now collapsible with
  Enter/Space, revealing the full commit message (subject, body paragraphs, harness-appended `Closes #…`
  trailer). A disclosure glyph (`▸` / `▾`) replaces one leading space; degenerate subject-only rows suppress
  the caret.

- **Cross-project sprint picker (`S`) and project picker (`P`).** Two new global hotkeys open modal
  overlay pickers that work from any view. The sprint picker's `t` key toggles scope between the current
  project and all projects. `setProjectAndSprint` on the `SelectionApi` updates project and sprint
  atomically — no partial state visible mid-transition.

- **Named responsive breakpoints + `useBreakpoint` hook.** `theme/tokens.ts` now exports a full web-style
  breakpoint vocabulary for terminal widths: `sm` (80), `md` (100), `lg` (140), `xl` (180), `xxl` (220).
  Pure helpers `breakpointFor`, `fluid`, and `responsive` let views resolve layout values without
  hardcoding column literals. `useBreakpoint()` hook re-derives on every `SIGWINCH` via the underlying
  terminal-size subscription, so any view that calls it reacts cleanly on resize.

- **Fluid Execute-view rail width at `xl`+.** `resolveRailWidth(columns)` returns a fixed 24-col rail
  below `xl` (< 180) and a `fluid`-grown 28→40-col rail at `xl`+ (ratio 0.18 of terminal width). The
  compact-rail `COMPACT_RAIL_WIDTH = 6` continues to apply at `md` (100–139).

- **`Element.label` + `TraceEntry.label` — human-friendly display labels for chain elements.** Flow
  authors can pass `leaf(name, config, { label })` to attach a display label without changing the
  canonical element name used for dedupe and trace correlation. The TUI `StepTrace` component renders
  `label` when present and mid-truncates to fit the rail column budget, preventing path-jammed element
  names from appearing in the rail.

- **Copilot `session.cwd` forwarded to spawned child process.** Provider adapters now pass
  `AiSession.cwd` as the child process working directory so context-file autoload
  (`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`), agents, and `.mcp.json` resolve
  correctly from the repo root rather than ralphctl's own cwd.

### Changed

- **Domain rename: `checkScript` → `verifyScript` everywhere.** Aligns the field name with the user-facing
  verb the harness emits in prompts (`<verify-script>`). Touches `Repository.{checkScript,checkTimeout}` →
  `{verifyScript,verifyTimeout}`, the `CheckRun` / `CheckRunOutcome` / `CheckRunPhase` types →
  `VerifyRun` / `VerifyRunOutcome` / `VerifyRunPhase`, the `Attempt.checkRuns` field → `verifyRuns`, the
  `pre-task-check.ts` / `post-task-check.ts` leaves → `pre-task-verify.ts` / `post-task-verify.ts`, the
  `run-check-script.ts` use case → `run-verify-script.ts`, the prompt section `## Check Script` →
  `## Verify Script` (placeholder `{{CHECK_SCRIPT_SECTION}}` → `{{VERIFY_SCRIPT_SECTION}}`), and every TUI
  label / log message in that domain. The Zod schema accepts the legacy keys on read; reach for a fresh
  start (`mv ~/.ralphctl ~/.ralphctl.bak`) if anything looks off.

- **One signal pipeline (file-based contract) for every AI-spawning leaf.** The three legacy
  flows (`review/review-round`, `detect-scripts/propose`, `detect-skills/propose`) migrated to
  the Zod-validated `<leaf>.contract.ts` shape that `implement`, `refine`, `plan`, `ideate`,
  and `readiness` already used. The AI writes one `signals.json` envelope to `outputDir` via
  its Write tool; the harness validates post-spawn via `validateSignalsFile`, fans signals to
  the sink + event bus, and renders sidecars from the validated array. Replaces a long-standing
  brittleness vector when CLI vendors tweak JSON shape.

- **Permission model split into capabilities and topology.** `SessionPermissions` now has
  `canModifyRepoFiles` (renamed from `canEditFiles`) which gates `Edit` / `MultiEdit` /
  `NotebookEdit` only; the `Write` tool is **always** allowed because the file-based contract
  requires it for `signals.json`. Path scope is the primary defense and lives on `AiSession`
  (`cwd` + `additionalRoots` + `outputDir`). A new `providers/_engine/resolve-roots.ts`
  helper auto-mounts `outputDir` as a writable root in every provider, so leaves never need
  to thread it manually. Codex collapses to `-s workspace-write` for every profile because
  its `read-only` sandbox blocks every write including `signals.json` — topology now carries
  the safety envelope on Codex.

- **Removed `CI=true` auto-retry for pnpm no-TTY aborts on `setup-script`.** A successful retry could mask
  drift from the real baseline the post-task verify gate later runs without `CI=true` (Maven Surefire skips
  `@DisabledIfEnvironmentVariable("CI")` tests, Spring Boot env-gated tests skip, pnpm switches to
  non-interactive / frozen-lockfile semantics). The marker detection and the actionable project-side hint
  (pin pnpm < 11, resync in a terminal, or set `confirm-modules-purge=false`) are preserved.

- **Shell scripts use narrow pnpm flag.** Setup and check scripts no longer set `CI=true` when
  invoking pnpm — the narrower `--reporter=default` flag is used instead, avoiding accidental CI
  detection in downstream tooling.

### Fixed

- **Copilot implement no longer truncates at 5 turns.** Copilot's `--autopilot` mode defaults
  `--max-autopilot-continues` to 5; implement-flow generators routinely take more
  continuations than that (read repo → think → edit → run verify → edit again, …) before
  emitting `task-complete`. Once the cap fired Copilot halted mid-task and `signals.json`
  never landed, surfacing as `signals-missing`. The Copilot headless adapter now always
  passes `--max-autopilot-continues=200`. Refine + plan worked previously because they go
  through the interactive provider, not headless autopilot.

- **`<decision>` signal parser drops runaway matches.** The decision parser now rejects bodies that exceed
  500 chars, contain `\n## ` (a section-header boundary), or have 3 or more code fences — so a malformed
  or adversarially-long `<decision>` block cannot pollute `decisions.log` or `progress.md`.

- **Render-time decision-line clip.** `render-progress-markdown.ts` clips each decision line at 160 chars
  with a `+N chars` hint as a second line of defence should any pre-cap entry reach the renderer.

- **Commit-message signal deduplication.** The AI's parse-time signal (no `fullMessage`) is dropped from the
  bucketed output whenever the harness-resolved version (with `fullMessage`) exists for the same task, so the
  TUI never shows two commit rows for one commit.

- **Signal body truncation replaced with flex-driven ellision.** The hardcoded 60/80-char clip is replaced by
  `<Text wrap="truncate-end">` inside a `flexGrow={1}` box so Ink ellides at actual rendered width. Multi-line
  payloads are pre-collapsed to one line before ellision.

- **Preflight-task step IDs cleaned up via `Element.label`.** The implement flow now attaches a short
  human-readable `label` (e.g. `preflight · my-repo`) to per-repo preflight leaves whose element `name`
  embeds an absolute path. Path-jammed names no longer appear in the step rail.

- **Copilot body-file capture honoured.** The Copilot headless adapter now respects `session.bodyFile`
  for forensic diagnostic capture so the response body is written to the configured path rather than
  discarded.

- **Copilot unrecognised JSON events preserved + body-text parser broadened.** Unknown JSON event
  objects are forwarded to the log instead of dropped; the body-text parser now matches a wider range
  of Copilot CLI output shapes for more robust signal extraction.

### Internal

- **`src/integration/ai/signals/` (24 files) deleted.** Production code is fully off the
  legacy XML-tag parser pipeline after the three remaining flows migrated. Per-kind parsers
  - parser registry + `consumeSignals` / `readSignalsFile` / `withSignalsTempPath` /
    `sink.ts` are gone. The 15 per-kind parsers moved to `tests/helpers/legacy-signal-parsers/`
    (test infrastructure only; `fake-ai-provider.ts` still uses them). Dead-only tests
    (`consume-signals.test.ts`, `temp-signals-file.test.ts`, `read-signals-file.test.ts`)
    deleted. `HarnessSignalSink` moves to `src/business/observability/harness-signal-sink.ts`.
    ESLint fence on `src/integration/ai/signals/**` prevents accidental re-creation.

- **Coverage thresholds in `vitest.config.ts`.** v8 provider with regression floors set ~5%
  below the 2026-05-23 baseline (statements 80 · branches 70 · functions 90 · lines 85);
  CI catches real drops without flapping on natural drift.

- **Sequence + data-flow diagrams under `.claude/docs/diagrams/`.** State machines and
  nested-subgraph flowcharts replaced with one-Mermaid-block-per-file sequence diagrams that
  narrate "what happens, in order." New `04-ai-session-data-flow.md` documents the file-based
  contract end to end.

- **`decisions-log-sink` caps decision body at 500 chars.** Defence-in-depth — the parser already rejects
  bodies over 500 chars, but the sink now slices independently so a non-parser source cannot produce a
  runaway `decisions.log` entry.

- **`state-projection.collectDecisions` miner caps mined bodies at 500 chars.** Same cap applied when
  mining `harness-signal` / legacy `decision` entries from `chain.log`, so pre-cap log files cannot inject
  over-length text into `progress.md` via the miner path.

- **Setup-script runner migrated off deprecated `SETUP_TAIL_BYTES`.** Both `SetupRun` and `CheckRun` now
  import `SCRIPT_TAIL_BYTES` from the shared constant; the deprecated `SETUP_TAIL_BYTES` alias is kept for
  backward compat until removed.

- **`commit-task` leaf re-emits `CommitMessageSignal` with `fullMessage`** after `appendTrailerToMessage` so
  TUI and audit-log consumers see the exact text that landed in git history, not the AI's pre-trailer proposal.

## [0.7.3] - 2026-05-20

### Added

- **Heap watchdog with memory-pressure TUI banner.** A background watchdog samples Node's heap and emits
  pressure events; a new `MemoryPressureBanner` surfaces sustained pressure in the TUI so OOM crashes
  aren't a surprise.

### Fixed

- **TasksPanel render cap.** Long-running sprints with many subSteps / evaluations no longer balloon the
  render tree — the panel now caps the rendered slice, with a covering test to prevent regressions.

### Changed

- **Spinner re-renders isolated.** The 90 ms spinner timer now lives in the leaf `<Spinner />` only, so
  unrelated TUI subtrees stop re-rendering on every tick. A render-budget test locks in the new behavior.

## [0.7.2] - 2026-05-19

### Fixed

- **Execute view shows real flow steps** instead of a placeholder, with a vertical task legend so
  long task lists no longer clip in the TUI.
- **Codex headless `--resume` args** are now passed correctly, so resume of an in-flight Codex
  session no longer reinvokes the model with a fresh context.

### Changed

- **Codex readiness and diagnostics parity** with Claude / Copilot — same probe surface, same
  signal vocabulary, same failure breadcrumbs.
- **Readiness probe-FS helpers deduplicated** and the probes themselves slimmed down; no behavior
  change, just less surface area to drift.

## [0.7.1] - 2026-05-19

### Added

- **Interactive dirty-tree preflight.** When `implement` starts on a dirty working tree (e.g. after
  an interrupted prior run), the user picks Keep / Stash / Reset / Cancel instead of being
  hard-failed. Stash uses `git stash push -u` with a recoverable message that includes the
  sprintId + timestamp; Reset is `git reset --hard && git clean -fd`; Cancel surfaces as
  `AbortError`. Non-interactive callers (CI, headless harness) keep failing fast by passing
  `dirtyTreePolicy: 'cancel'`.
- **Task unblock recovery hatch.** Tasks that settled to `blocked` can now be unblocked from the
  TUI's Sprint Detail view and from the `ralphctl task` CLI — re-running `implement` then picks
  them up on the next attempt without manual JSON surgery.

### Fixed

- **Claude provider streams JSONL** instead of buffering until the session exits, so the
  idle-stdout watchdog no longer kills healthy sessions during long generator turns.
- **Codex interactive launches emit `--add-dir`** for `additionalRoots` and the prompt / output
  dirs, so the harness-controlled file contract (`signals.json`, `prompt.md`, `done-criteria.md`)
  is actually visible to the running model.
- **Plan flow roots its AI session** at `<sprintDir>/plan/<run-slug>/` instead of `repositories[0]`,
  and mounts **every** project repository as an equal `--add-dir` source. Multi-repo planning now
  treats every repo symmetrically — no cwd privilege for the first one, no biased auto-loading of
  one repo's `CLAUDE.md` / agents / `.mcp.json`.
- **Refine flow roots its AI session** at `<sprintDir>/refinement/<ticket-slug>/` instead of the
  repo. Refinement is implementation-agnostic, so it no longer auto-loads the repo's
  provider-native context file and no longer pollutes the repo with bundled skills.

## [0.7.0] - 2026-05-18

> **Structural rewrite.** Internal architecture, on-disk schema, data root, and several CLI commands
> all changed. **No automatic migration from 0.6.x** — see [README §Upgrading](./README.md#upgrading-from-06x-to-070).

### Breaking

- **On-disk schema is incompatible with 0.6.x.** 0.7.0 reuses `~/.ralphctl/` as the data directory
  (override with `RALPHCTL_HOME=<absolute-path>`), but **back up your 0.6.x data before launching**.
  Each sprint now spans three files — `sprint.json` (planning), `execution.json` (branch / PR / setup
  audit), `tasks.json` (the task list) — instead of the single 0.6.x `sprint.json`. The 0.6.x layout
  does not parse; the first read against legacy files surfaces a `ParseError`. Recommended:
  `mv ~/.ralphctl ~/.ralphctl.0.6-backup` before installing 0.7.0.
- **`settings.json` schema changed.** Per-flow model selection replaces the single global `model`
  setting; each chain (`refine`, `plan`, `implement`, `ideate`, `readiness`) picks its own. 0.6.x
  settings files are rejected on read — re-run `ralphctl settings` to reconfigure.
- **CLI surface intentionally smaller.** These commands were removed in favour of the TUI:
  `sprint feedback / edit`, `ticket approve / edit`, `project repo add / remove`, all
  `task add / edit / edit-status / remove`, and `sessions list / attach / detach / kill`. If you
  scripted any of these, switch to the interactive TUI or to the relevant flow command.

### Added

- **Per-run forensic artifacts for one-shot flows.** `detect-scripts`, `detect-skills`, and
  `readiness` now persist `<dataRoot>/runs/<flow>/<run-id>/{prompt.md,body.txt}` per AI call.
  Artifacts survive after the chain exits — user-managed lifecycle (`rm -rf` at will, no auto-GC,
  symmetric with `<sprintDir>/chain.log` for sprint flows). When the AI returns an empty proposal
  the confirm leaf splices the raw body inline ("AI response: …") so a permission ask or
  format slip is visible without leaving the TUI. `readiness` splices the same body into the
  `ParseError` hint when the tool-specific wire tag is missing. Only the Claude provider
  implements `bodyFile` today; Copilot / Codex no-op the field per the documented contract.
- **OpenAI Codex provider** alongside Claude Code and GitHub Copilot — pick via `ralphctl settings`.
- **Per-flow model selection.** Each chain (`refine`, `plan`, `implement`, `ideate`, `readiness`)
  carries its own model, configurable in `settings.json` or via the settings view.
- **Cross-project sprint lock** prevents two ralphctl sessions on the same machine from racing
  one sprint's on-disk state.
- **Idle-stdout watchdog** kills wedged headless provider children so a stuck Claude / Copilot /
  Codex process can't strand the harness.
- **Resume of aborted Implement runs.** A killed implement loop recovers in-progress tasks on
  the next launch instead of starting clean.
- **Persistent `<sprintDir>/chain.log`** — every chain run streams its trace to disk for post-hoc
  debugging.
- **File-based AI provider contract** — `signals.json` + `sessionId` files replace stdout parsing,
  closing a long-standing source of brittleness when CLI vendors tweak their JSON shape.
- **Exponential backoff on rate-limit retries** (`provider._engine/rate-limit-backoff`).
- **`gen:flow` scaffold generator** — `pnpm gen:flow <name>` produces the manifest + flow stub a
  new chain needs.
- **EventBus + chain-progress streaming.** Adapters publish structured events that the TUI
  subscribes to live (no more polling).
- **Legacy-layout safeguard at boot.** Detects v0.6.x leftovers at `~/.ralphctl/` (`cache/`,
  `logs/`, `backups/`, top-level `config.json`) and refuses to start, printing the exact backup
  command. No data is touched. Mirrors the v0.6.0 detector that caught the v0.5.x → v0.6.0
  upgrade footgun. Bypass for tests / power users: `RALPHCTL_SKIP_LEGACY_CHECK=1`.

### Changed

- **Internal architecture rewritten** to a function-first composition (no class instances for use
  cases). `Result<T, E>` end-to-end — every `process.exit(1)` is a pattern-matched typed error.
  ESLint enforces the new layer rules (`domain → nothing`, `business → domain`,
  `integration → domain + business`, `application → everything`) plus sibling-isolation rules
  inside `integration/ai/` so flows speak port-level vocabulary only.
- **Prompt corpus tightened by ~36%** with no semantic loss on the rubric, anti-stamp guard, or
  parameter validation — `evaluate` template went from 276 → 150 lines via XML-block → markdown
  conversion. Each template now ships with a branded `Prompt` type and per-template parameter
  schema, so prompt regressions surface at type-check time.
- **TUI rewritten** as a responsive dashboard with a kanban-style Sprint Detail view, a
  pipeline-map Home view, and a multi-chain session switcher (`SessionsView`). Banner is
  persistent across views, help overlay (`?`) is generated from the central `keyboard-map.ts`.

### Removed

- The class-based use-case layer, the kernel module (chain primitives now live in
  `application/chain/`), and the `PersistencePort` monolith — replaced by per-aggregate repositories
  (`ProjectRepository`, `SprintRepository`, `SprintExecutionRepository`, `TaskRepository`).
- v1-only TUI dependencies: `@inkjs/ui`, `colorette`, `gradient-string`, `tabtab`. v0.7.0 ships a
  hand-rolled inline gradient renderer + Ink-native primitives.

### Fixed

- **Claude headless permission mapping.** Read-only flows (`refine`, `plan`, `readiness`,
  `detect-scripts`, `detect-skills`) previously mapped `READ_ONLY` to `--permission-mode plan`.
  Recent Claude Code versions require interactive approval for _every_ tool under plan mode —
  including Read / Grep / Glob — so headless `claude -p` sessions silently fell through with no
  signals and the model emitted a human-facing "please grant read permission" body instead of
  the expected harness tags. Operators saw an empty proposal at the confirm prompt with no
  obvious diagnosis. Every headless session now runs under `--permission-mode bypassPermissions`
  with a `--disallowedTools` deny list scoped to the configured `SessionPermissions`; Claude's
  deny rules take precedence over bypass, so writes / shell / network stay blocked while reads
  flow. No behavioural change for full-auto sessions.

## [0.6.3] - 2026-05-06

### Changed

- **Setup ≠ check.** Sprint start now runs each repo's configured `setupScript` (the deterministic
  baseline so Claude departs reliably) via the renamed `setup-scripts-sprint-start` chain leaf,
  iterating `sprint.affectedRepositories` and stamping `Sprint.setupRanAt[repoPath]`. Any setup
  failure — non-zero exit OR spawn-level error (missing binary, EPERM, ENOENT, …) — hard-aborts
  the chain as `InvalidStateError({ currentState: 'setup-failed' })` naming the failing repo. The
  per-task prompt's `{{ENVIRONMENT_STATUS}}` slot renders "Setup script ran at <ISO>" instead of
  the old "Pre-task environment check passed at" string.
- **Sprint resume skips already-stamped repos.** The `setup-scripts-sprint-start` leaf no-ops per
  repo when `Sprint.setupRanAt[repoPath]` already carries a timestamp, so a sprint killed mid-run
  reaches the per-task fan-out without re-running setup. The existing stamp is preserved.
- **Per-task `checkScript` is auto-sourced.** A new `resolve-check-scripts` chain leaf (runs in the
  initialize phase before setup) walks the sprint's project once and populates `ctx.checkScripts`
  with each affected repo's configured `Repository.checkScript`. The per-task bridge seeds the gate
  per-task without the user passing `--check-script`. The CLI flag stays as a global override
  (and its help text now says so).
- `execution/<unit-slug>/` slimmed: dropped per-unit `tasks.json` and `prior-evaluations/`; sibling
  evaluator output now renders inline inside `tasks.md`.

### Fixed

- **Per-task verification gate is a hard fence.** `PostTaskCheckUseCase` returns
  `Result.error(CheckFailedError)` on a non-zero exit. The per-task chain wraps it in
  `OnError(catchIf: code === 'check-failed')` and transitions the task to `'blocked'` (reason:
  "post-task check failed") instead of letting `mark-done` proceed.
- **Per-task spawn-level errors degrade gracefully.** The post-task `checkScript` gate, the
  execution-unit builder, and the evaluator each wrap their inner leaf in a soft `OnError` that
  absorbs anything except `aborted` and the gate's own hard error code, so a missing binary /
  EPERM doesn't strand a task. `resolve-check-scripts` runs before the setup leaf so the per-task
  gate keeps its check-script map even when sprint-start setup hard-aborts.
- **Legacy `sprint.json` files load.** Sprint files written by v0.6.2 (carrying `checkRanAt: {}`
  with no `setupRanAt` key) parse successfully; the legacy key is silently dropped on the next
  save, so the file self-cleans without a migration step.

## [0.6.2] - 2026-05-04

Hotfix on top of 0.6.1. The previous bundles silently no-op'd when invoked through the npm-installed
`ralphctl` shim — so `npm i -g ralphctl && ralphctl --version` exited 0 with no output.

### Fixed

- `entrypoint.ts#shouldAutoInvoke` no longer rejects symlinked bins. The basename allowlist
  (`cli.mjs` / `entrypoint.ts`) skipped `main()` when `process.argv[1]` was the npm-global
  `<prefix>/bin/ralphctl` symlink. Replaced with the canonical "am I the entry module?" check —
  resolve `argv[1]` through `realpathSync` and compare against `import.meta.url`. Added an e2e
  regression that spawns `dist/cli.mjs` through a renamed symlink and asserts on the version output.

## [0.6.1] - 2026-05-04

Quality follow-up to 0.6.0 — bumps the build chain to TypeScript 6, lifts a runtime patch on `zod`, and
deflakes a CI race in the ticket-add view test that intermittently failed on slower runners.

### Changed

- `pnpm update --latest` — TypeScript 5.9.3 → 6.0.3, `zod` 4.3.6 → 4.4.3, `typescript-eslint` 8.59.0 →
  8.59.2, `eslint` 10.2.1 → 10.3.0, `knip` 6.9.0 → 6.11.0, `globals` 17.5.0 → 17.6.0
- `tsconfig.json` — drop the now-deprecated `baseUrl` and root `paths` at `./` (TS 6 promoted the
  `baseUrl` deprecation to a hard error; `paths` resolves relative to `tsconfig.json` since TS 5.0)

### Fixed

- `ticket-add-view` test no longer races the React render cycle on CI. The frame-text assertion is now
  folded into the same `vi.waitFor` that watches the confirm-mock count, closing the gap that let CI
  snapshot a `Starting…` frame before the second-add success card had rendered.

## [0.6.0] - 2026-05-04

### Added

- **5-module Clean Architecture** (kernel / domain / business / integration / application) with strict ESLint
  layer fences
- **Kernel chain framework** — Element / Leaf / Sequential / Retry / OnError + ChainRunner runtime; five
  primitives, no concurrent fan-out (a `forEachItem`-shaped primitive is deferred until a second consumer
  materialises)
- **Multi-chain SessionManager** — N chains run concurrently; Tab cycles, Ctrl+1..9 jumps;
  foreground/background detaches without killing
- **Chain definitions:** refine, plan, ideate, execute, evaluate, feedback, **create-pr** (new),
  **onboard** (extended interview mode — setup + verify + CLAUDE.md + skill suggestions)
- **Sandbox workspaces for refine / plan / evaluator** — refine and plan AI sessions run in dedicated
  `<sprintDir>/workspaces/{refine,plan}/` sandboxes instead of hijacking the user's first repo. Affected
  repos are exposed via `--add-dir` (Claude) or mirrored under `workspaces/<phase>/repos/` (Copilot). The
  evaluator (and its fix-loop) gets a `<sprintDir>/workspaces/evaluate/` contract pack with refined
  requirements, full task plan, project context, dimension definitions, and prior sibling task evaluations —
  refreshed per round. Workspaces persist as durable debugging artefacts.
- `WorkspaceBuilderPort` (`src/business/ports/workspace-builder-port.ts`) with four methods:
  `buildRefineWorkspace`, `buildPlanWorkspace`, `buildEvaluateWorkspace`, `refreshEvaluateWorkspace`;
  `FileWorkspaceBuilderAdapter` is the implementation
- New chain leaves: `build-refine-workspace`, `build-plan-workspace`, `build-evaluate-workspace`
- `render-prompt-to-file` leaf — renders the full prompt template with all placeholders filled, asserts no
  `{{TOKEN}}` remains, writes to `<sprintDir>/contexts/<flow>-<id>.md`, and hands the AI a thin wrapper
  pointing at that file. Inserted into execute (per-task), feedback, and other AI-spawning flows.
- `WriteContextFilePort` (`src/business/ports/write-context-file-port.ts`) + `FileWriteContextFileAdapter`
  (`src/integration/persistence/file-write-context-file-adapter.ts`) — dedicated port for writing context
  files to the sprint working directory; replaces the ad-hoc file writes previously embedded in use cases
- `resolve-branch` leaf in `executeFlow` — prompts keep / auto / custom on first run when no branch is set,
  validates, persists via `Sprint.setBranch()`, and creates the branch in every unique `task.projectPath`;
  skips silently on resume
- `dirty-tree-preflight` leaf in `executeFlow` — detects uncommitted changes before check scripts run;
  user chooses stash / hard-reset / cancel
- `summarise-execution` leaf in `executeFlow` — emits a structured completion summary after `unlink-skills`
- `detect-existing-files` + `confirm-start-ai` leaves in `onboardFlow` — inspect the repo for a prior
  project context file and confirm with the user before launching the AI inventory session
- `load-tasks` step in `feedbackFlow` — loads the completed task list so the AI receives full context
- **Dependency-aware execute dashboard** — `<TaskExecutionList />` renders depth-indented per-task cards
  (status pill, activity line, depends-on line, blocked reason); `dag-depth.ts` provides the shared
  topological BFS ordering; `<TaskExecutionGrid />` is a thin wrapper that adds the section header
- `onCtxUpdate` callback on `Element.execute` — `ChainRunner` exposes live `.ctx` between steps so the
  TUI execute view can populate the task list without waiting for the chain to settle. All four primitives
  (Leaf, Sequential, Retry, OnError) thread the callback transparently
- `Task.resetToTodo()` — resets a stale `in_progress` task back to `todo`; used by the
  `reset-stale-in-progress` leaf in `executeFlow` to recover tasks left open by a prior crash
- **Per-phase skills bundles** — `BundledSkillsCopier` installs the union of `default/` and `<phase>/`
  (refine / plan / exec) into `<cwd>/.claude/skills/`. Project-authored skills always win — same-named
  bundled skills are skipped at install and never removed at uninstall. Per-cwd install manifest tracks
  only what was copied so uninstall doesn't `rm -rf` the user's tree
- `mark-blocked` task status with reason
- Multi-round evaluator fix loop with plateau detection
- Live config read per task settlement
- Progressive chain trace (subscribers receive `step` events as they happen)
- Persistent banner across all views; help overlay as modal takeover; prompt transcript above active prompt
- Pipeline map on home with bright "Next step" quick-action; tiered browse menu
  (Sprint / Ticket / Task / Project drill-ins)
- Schema-driven settings panel
- Doctor view + onboarding-status check + log path surfacing
- Shell tab-completion (bash / zsh / fish) with COMP\_\* intercept
- `sprint progress` (with health folded in) + `sprint requirements` + `sprint context` exports
- `Repository.setupScript` + `onboardedAt` fields; `Sprint.pullRequestUrl`
- Storage layout: `~/.ralphctl/{config,data,cache,logs,backups}/`
- First-launch wizard — bare `ralphctl` on a fresh install routes the user straight to project-add with
  a welcome card; non-TTY surfaces a friendly hint instead of help noise
- Legacy-layout detector at boot — refuses to start on a 0.5.x `~/.ralphctl/` and prints back-up
  instructions, since the on-disk schema is incompatible

### Changed

- Read version from `package.json` at build time (was hardcoded)
- Repository interfaces moved to domain layer; service ports stay in business
- Per-aggregate repositories (`SprintRepository` / `ProjectRepository` / `TaskRepository`) replace the
  monolithic `PersistencePort`
- **Execute flow runs strictly sequentially** — `executeFlow` uses a `Sequential` of topologically-ordered
  per-task chains; tasks execute one at a time in dependency order
- **Execute prompt consolidated** — task data is inlined in the rendered prompt file; the legacy two-file
  split (task context + prompt) is gone, `WriteTaskContextUseCase` removed
- CLI `--branch <name>` flag split into `--branch` (boolean, auto-generate `ralphctl/<sprint-id>`) and
  `--branch-name <name>` (custom name); both pre-seed `sprint.branch` so the `resolve-branch` leaf skips
  its prompt
- Evaluator `OnError` passes through `code: 'aborted'` — Ctrl+C mid-evaluator no longer swallows the
  cancel and silently marks the task done
- `EvaluateAndFixLoopUseCase` accepts optional `addDirs`, `evaluateSessionCwd`, `evaluateWorkspaceDir`,
  and `refreshWorkspace` — the standalone `sprint evaluate` chain leaves them undefined and runs unchanged
- Plan task-id parser accepts placeholder strings; the harness mints the real `TaskId` and resolves
  `blockedBy` through a placeholder→id map. Eliminates "task id must be 8 lowercase hex characters" and
  "depends on unknown task" errors when the AI emits friendly local ids
- Plan / ideate downstream guards — task `projectPath` and `ticketId` are validated against the sprint's
  affected repositories and tickets at parse time; empty task lists error at parse time

### Fixed

- **Plan no longer drops `.claude/skills/` into the user's first repo** — the `repos[0] ?? opts.cwd` bug
  is fixed; skills now land in the sandbox workspace

### Removed

- Legacy 4-module `src/` layout
- Pipeline framework (replaced by kernel chain framework)
- Daemon process registry + `sprint list-runs` / `attach` / `stop` / `why` (intentional cut)
- `sprint insights`, agents-md linter, version-check, completion handlers (legacy)

### Breaking

- `~/.ralphctl/` schema is incompatible with 0.5.x — see migration note in README

## [0.5.0] - 2026-04-24

### Fixed

- **Evaluator fix-loop now actually fixes things** — failed evaluations resume the
  generator session via `--resume <session-id>` (Anthropic's recommended
  generator-evaluator pattern) and deliver the full fix protocol from
  `task-evaluation-resume.md` instead of a 4-line hardcoded string. The loop no
  longer early-bails when the generator omits `<task-complete>`, and the final
  re-eval is skipped on the last iteration — saving a multi-minute spawn per
  failing task. Failure logs now report the actual iteration count rather than
  the configured cap.

### Changed

- **Evaluator option types collapsed** — pipeline `EvaluateOptions` folded into
  domain `EvaluationOptions` + a `force` flag; `generatorSessionId` /
  `generatorModel` relay fields removed from `EvaluateContext`. Evaluator-spawn
  and generator-resume now share a single `spawnOrNull` helper for error
  handling.

## [0.4.6] - 2026-04-24

### Fixed

- **Check-script output no longer truncated mid-build** — the lifecycle hook
  now streams stdout/stderr into a 50 MB buffer instead of relying on
  `spawnSync`'s silent 1 MB cap, so real builds (`mvn`, large test suites)
  surface the actual failure instead of a spurious "check failed".
- **Failure reason surfaces in the execute view** — the per-task failure
  card now carries the underlying `StepError` (message + step name) and
  pins above the keyboard hints; the log tail auto-sizes to the terminal
  height. Check-script errors render the **last** lines of output, where
  build tools actually report failures.
- **Lifecycle hook timeouts now kill the whole process tree** — spawning
  with `detached: true` and signalling `-pid` ensures grandchildren
  spawned by `sh -c` (e.g. `sleep`) are reaped on Linux instead of
  holding stdio open and hanging the close handler.

## [0.4.5] - 2026-04-24

### Fixed

- **Version-check cache TTL reduced from 24h to 1h** — update notifications now
  surface the same day a release lands on npm rather than up to a day later.

## [0.4.4] - 2026-04-24

### Added

- **Running-executions view + backgrounding** — TUI gains a router destination listing active
  sprint executions with status, elapsed time, and current activity. `Esc` from an execute view
  now backgrounds the run instead of tearing it down; the run keeps progressing and can be
  re-attached or cancelled from the list. A completion banner surfaces finished backgrounded
  runs next time the user lands on home.
- **`ExecutionRegistry` port + per-execution scope** — in-memory adapter tracks every live
  `ExecuteTasksUseCase` invocation with its own `SignalBus` scope, so dashboards, notification
  banners, and the running-executions view share one source of truth without leaking subscribers
  across runs.
- **`AbortSignal` plumbing through the scheduler** — cancellation propagates from the registry
  through `forEachTask`, the per-task pipeline, and the AI session adapter. New `cancelled`
  terminal variants distinguish user-initiated stops from errors in `stopReason`, task status,
  and signals.
- **Interactive dirty-tree handling on sprint resume** — when `sprint start` finds uncommitted
  changes in a sprint repo, the harness now runs a two-step Y/n prompt (`Resume with existing
changes? [Y/n]` → `Reset to latest commit and resume? [Y/n]`) instead of hard-blocking.
  Non-interactive contexts still block by default and surface a hint naming both new override
  flags: `--resume-dirty` (keep changes intact) and `--reset-on-resume` (discard tracked
  modifications + untracked files, then resume). The two flags are mutually exclusive.
- **`RemovalWorkflow` component** — shared state machine + surface for destructive flows (sprint
  delete, project / repo / ticket / task remove). Replaces five near-identical view
  implementations.

### Changed

- **Sprint delete is now single-confirm** — the former two-step "Are you sure? / Really sure?"
  chain collapses into one confirmation citing the destructive detail (ticket + task counts).
- **Global hotkeys fire from every view** — `h` / `s` / `d` / `?` / `q` / `Esc` now dispatch
  consistently from browse detail views (ticket-show, task-show, …) where child `useInput`
  handlers could previously mask them. Dispatch extracted into a `useGlobalKeys()` hook installed
  from every `<ViewShell>`.
- **Evaluator is stricter about rubber-stamping** — `task-evaluation.md` now requires a concrete
  per-dimension observation before `<evaluation-passed>`; bare `**Correctness**: PASS` lines
  without a justification parse as `status: failed`. Existing sprints may see more `failed`
  evaluation outcomes by design; the fix-and-reeval loop handles them like any other real failure.
- **Prompt guardrail against sprint-local identifiers** — `task-execution.md` and
  `sprint-feedback.md` now instruct the implementer to describe invariants directly rather than
  citing ephemeral sprint metadata (`AC1`–`AC6`, ticket / task / sprint IDs) in committed code.

### Fixed

- **Cancellation actually kills the subprocess and drains `in_progress`** — aborting a run via
  the running-executions view or `Ctrl+C` now terminates the spawned AI CLI immediately and
  resets any `in_progress` tasks back to `todo` so the next resume starts from a clean state.
  Cross-sprint + cross-project concurrency is pinned by a new regression fence.
- **Plan import preserves `verificationCriteria` and `extraDimensions`** — re-plan rounds no
  longer strip planner-emitted grading contracts when an existing task is reused, keeping the
  evaluator's rubric intact across iterations.

### Removed

- **`.claude/docs/PROMPT-AUDIT.md`** — the doc's invariants are now enforced as assertions in
  `src/integration/ai/prompts/loader.test.ts` (canonical XML vocabulary, TUI/CLI surface parity,
  generic-content audits) and summarised inline in `CLAUDE.md § Prompt Template Engineering`.

## [0.4.3] - 2026-04-22

### Added

- **`ralphctl project onboard <name>` (#77)** — AI-assisted per-repo bootstrapping of the
  provider-native project context file (`CLAUDE.md` for Claude, `.github/copilot-instructions.md`
  for Copilot) plus a check-script suggestion. Pipeline-backed (`load-project → select-repo →
repo-preflight → ai-inventory → validate-agents-md → retry-agents-md-on-violation → check-drift
→ review-and-confirm → write-artifacts → verify-check-script`) with structural lint + one-shot
  retry on violation. Three auto-detected modes: `bootstrap`, `adopt` (authored file — proposal
  only, never overwrites), and `update` (prior `onboardingVersion` marker — diff with `<changes>`
  rationale). `--dry-run` surfaces the proposal without writing; `--auto` skips review. Full TUI
  parity via `ProjectOnboardView` — reachable from the home project submenu.
- **Per-repo onboarding row in `doctor` (#77)** — reports pass / warn / skip for each
  (project, repo) based on `onboardingVersion`, the provider-native file's presence, and
  `LOW-CONFIDENCE:` markers. Skips cleanly when no AI provider is configured. Doctor view
  rerendered with section blocks + per-section column alignment; hints prefixed with `ralphctl`
  for copy-paste.
- **AI-assisted check-script discovery (#76)** — when static heuristic detection finds nothing
  during `project add` / `project repo add`, a short AI session inspects the repo and proposes a
  check script via the `<check-script>` signal. Editable suggestion only — never a runtime
  fallback.

### Changed

- **README leads with the TUI** — new TUI screenshot + interactive quickstart up front; plain-text
  CLI is now framed as the non-TTY fallback rather than the primary surface.
- **Dev-dependency refresh** — bumped `vitest`, `eslint`, and `typescript-eslint` to current
  majors.

## [0.4.2] - 2026-04-20

### Changed

- **Prompt templates audited for downstream generality (#75)** — all 15 templates under
  `src/integration/ai/prompts/*.md` now follow a canonical XML vocabulary (`<context>`,
  `<requirements>`, `<constraints>`, `<examples>`, `<dimension>`, `<task-specification>`) per
  Anthropic's prompt-engineering guidance. Per-file audit report at `.claude/docs/PROMPT-AUDIT.md`.
- **De-Node-ified example JSON** — `{{CHECK_GATE_EXAMPLE}}` placeholder replaces hardcoded
  `pnpm`/`npm` strings so prompts render cleanly in Python / Go / Rust / Java downstream projects.
  Default now reads "omit this step when the project has no check script" so planners don't push
  a check-gate criterion on projects without one.
- **`plan-common.md` trimmed 263 → 197 lines** — illustrative good/bad JSON + dependency-graph
  examples extracted into a new `plan-common-examples.md` partial wrapped in `<examples>` to signal
  non-normativity. Savings compound across four inlined planner prompts.

### Added

- **`<thinking>` scratchpad in headless planners** — `plan-auto` and `ideate-auto` now direct the
  planner to reason in `<thinking>…</thinking>` before emitting JSON. Evidence-backed CoT lift;
  the JSON extractor already skips pre-bracket content, so no parser work needed.
- **CI-locked anti-patterns in `loader.test.ts`** — no `ralphctl` string in any template, no
  hardcoded subagent names, no literal package-manager commands outside the placeholder seam.
  TUI-parity fixture asserts byte-identical output across callers.

## [0.4.1] - 2026-04-20

### Fixed

- **Dirty-tree leaks after task settlement** — tasks and end-of-sprint feedback iterations could
  leave uncommitted changes in the repo if the generator skipped its commit step. Two-layer fix:
  - `sprint-feedback` prompt now mandates a commit before completion; `task-evaluation` prompt
    declares a read-only posture and requires a clean tree in Phase 1.
  - New `recover-dirty-tree` pipeline step (between `evaluate-task` and `mark-done`) and matching
    hook in the feedback loop. If the tree is still dirty at settlement, the harness warns, emits
    a `Note` signal to `progress.md`, and auto-commits via a new `ExternalPort.autoCommit`.
    Non-blocking — `mark-done` always runs, even if the auto-commit itself fails.

## [0.4.0] - 2026-04-19

### Added

- **`ralphctl next`** + **`ralphctl task why`** — explain the next recommended action and a task's
  rationale; surfaced via the REPL task submenu.
- **Auto mode for refine + plan** — `--auto` flag (and matching REPL toggle) on `sprint refine` and
  `sprint plan` runs the AI loop without HITL approval prompts.
- **Loop ticket add (TUI)** — Ink `ticket add` view now prompts "Add another?" after each save and
  reports the running count, matching the plain-text CLI.
- **Scrollable confirm details** — the requirements approval prompt's bordered details block is now
  viewport-sized; ↑/↓ scroll one line, PgUp/PgDn paginate, with a `lines N–M of T` indicator.
- **Live refine overview** — `RefinePhaseView` polls the sprint while the pipeline runs so the
  approved/pending counters and per-ticket badges update as each ticket settles.
- **Live execution grid** — `ExecuteView` re-reads persisted tasks on every `task-finished` signal so
  the progress counter and per-task statuses tick during the run.
- **Per-step trace** — new `task-step` `HarnessEvent` is emitted around every per-task pipeline step
  (`branch-preflight`, `contract-negotiate`, `mark-in-progress`, `execute-task`, `store-verification`,
  `post-task-check`, `evaluate-task`, `mark-done`). The dashboard surfaces a labeled spinner per
  running task above the Log section ("Running Claude…", "Evaluating…", …) and mirrors the label as
  the task's row activity.

### Fixed

- Removed the duplicate `Completed: <task>` log line that was emitted by both the scheduler's
  `onSettle` callback and the `mark-done` step. The pipeline step now owns it.

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
