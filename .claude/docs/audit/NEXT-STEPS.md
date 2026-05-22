# Next steps — audit implementation status

Snapshot of work-completed-vs-work-remaining for the audit at
`.claude/docs/audit/`. Update in place as steps land.

## Done

### Step 1 — [04] setup-script lifecycle gate

- Resume-vs-new gate based on `SprintExecution.setupRanAt`. Prior `success` row for
  the current command → skip; failures and command-drift → re-run.
- `skipped on resume` log line distinguishes from `skipped because no script`.
- 4 new tests on `setupScriptRunnerLeaf`.

### Step 2 — [09] foundation: contract engine + signal schemas

- `src/integration/ai/contract/_engine/{types.ts, validate-signals-file.ts,
render-sidecars.ts, render-contract-section.ts, render-evaluation-markdown.ts}`.
- `signals/<kind>/schema.ts` per existing `HarnessSignal` kind.
- Domain: `MigrationGapError`, `AiSignal` alias for `HarnessSignal`.
- 14 unit tests across the engine modules + per-kind smoke tests.

### Step 3 — [11] prompt template parity tests + ESLint rule (deferred)

- `_engine/test-utils.ts`: `expandPartials`, `loadPartialMap`, `computePlaceholderParity`.
- Per-flow `definition.test.ts` added for `apply-feedback`, `detect-skills`, `ideate`.
- `template-coverage.test.ts` — Vitest meta-test that fails when a flow
  ships without its parity test. (Equivalent to the audit's proposed ESLint
  rule; same enforcement, no custom plugin.)

### Step 4 — [10] mock AI provider helper

- `tests/helpers/mock-headless-provider.ts` with the nine-branch `SpawnFixture`
  union (`ok` / `ok-missing` / `ok-raw` / `spawn-error` / `abort`).
- 7 self-tests covering every branch.

### Step 5 — [09] per-leaf migration to the audit contract

Landed on `feature/improvements` as a sequence of waves, consolidated in
commit `f69bc1ba`:

- Foundation: `RALPHCTL_DEBUG_TRACE` env-var gate moved into `wire()`
  via a `chainLogSink` factory on `AppDeps`; `--add-dir <sprintDir>`
  added to generator + evaluator sessions.
- Generator + commit-task: `commit-message.txt` sidecar; `commit-task`
  reads validated signal from ctx; `fullMessage` extension field
  dropped (three TUI consumers updated).
- Evaluator: `evaluation.md` sidecar via `renderEvaluationMarkdown`;
  `exactlyOne('evaluation')` refinement.
- Refine / plan / ideate: each contract enforces `exactlyOne` for its
  primary signal; no sidecars — projection consumes validated signals
  directly.
- Readiness: three optional sidecars (`agents-md-proposal.md`,
  `setup-skill.md`, `verify-skill.md`); skills adapter gains
  `installBareSkill` for de-prefixed `<parentDir>/skills/{setup,verify}/`
  installs.
- Atomic flip: prompt templates substitute `{{OUTPUT_CONTRACT_SECTION}}`;
  headless providers no longer parse XML tags — the AI's `Write` tool
  emits the envelope directly. Forensic body buffer preserved.
- ESLint fences: chains-layer rule blocks `contract/signals/**` outside
  `_engine/`; `fs.appendFile` banned outside `integration/io/`.

Three legacy flows (`apply-feedback`, `detect-scripts`, `detect-skills`)
were intentionally left on `parseHarnessSignals` — outside the audit's
scope. A follow-up wave can fold them in when convenient.

### Step 6 — [07] progress.md journal model

Landed in commit `c0a44f4d`:

- New `AppendFile` port + integration adapter; the two Wave-6
  eslint-disable + TODO markers resolved (file-log-sink, review-round).
- `progress-journal-leaf` appends one `## Task: <name> — Attempt <N>`
  section after each settle-attempt; per-attempt decision count from
  validated decision signals.
- Sprint create / activate / review / close write separator lines via
  a shared helper.
- `chain.log` → `events.ndjson` at `<sprintDir>` root (opt-in only via
  `RALPHCTL_DEBUG_TRACE`).
- `{{PRIOR_PROGRESS}}` added to implement / refine / plan / ideate
  prompts (readiness untouched).
- Deleted: state-projection, load-chain-log, load-decisions-log,
  parse-chain-log-line, parse-decisions-log-line, render-progress-
  markdown, render-snapshot-text, write-progress-snapshot,
  decisions-log-sink, ensure-progress-file leaf, sprint regenerate-
  progress CLI, snapshot CLI subcommand.

### Step 7 — [01] + [06] logs layout + entity slimming

Logs/ layout landed earlier; entity slimming + per-entity migrations
landed in the persistence-refactor commit on this branch:

- `setupScriptRunnerLeaf` writes `<sprintDir>/logs/setup/<repo-id>.log`;
  `pre-/postTaskVerifyLeaf` write
  `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log`.
- `runVerifyScriptUseCase` returns `{ run, rawOutput }`.
- Dropped `stdoutTailBytes`/`stderrTailBytes` from `SetupRun` +
  `VerifyRun`; consumers lazy-read via new `LogTailReader` port
  (default cap 4 KiB).
- `schemaVersion: 1` + `migrations[0]` on Sprint, SprintExecution,
  Task. Settings already had the pattern.
- `tasks.json` root changes from bare `Task[]` to
  `{ schemaVersion, tasks }`; migration lifts the legacy array, drops
  verifyRun tail-bytes, renames `checkRuns` → `verifyRuns`.
- Shared helper at `integration/persistence/_engine/run-migrations.ts`
  mirrors the audit-[09] chain walk.

### Step 8 — [03] truncation sweep

- `src/domain/value/script-tail-bytes.ts` deleted; both `tailBytes(...)` call sites in
  `setup-script-runner.ts` + `post-task-verify.ts` removed (verbatim round-trip per audit).
- `SINK_BODY_CAP` already absent (Wave 7 removed `decisions-log-sink.ts`); stale doc
  reference in `events.ts` cleaned.
- Display-clip glyph tokens added to `theme/tokens.ts` (`clipEllipsis` U+2026 and
  `collapseExpand` `▼ more`). Marker rule applied to TUI clip sites: step-trace label
  truncation, evaluator-failure critique excerpt, sprint-detail first-line clip,
  multi-flow strip title, execute-view task name, tasks-panel signals / orphan signals /
  criteria collapse, field-list over-wide label, issue-pusher stdout excerpt.
- Banner-clip unit decision: JS `String.prototype.length` (UTF-16 code units) at the
  setup-script tail emitter — documented inline at the call site; grapheme clipping is
  overkill for shell stdout in practice. Round-trip test fixtures cover ASCII +
  multi-byte UTF-8 + emoji edges.

### Step 9 — [05] / [08] done-criteria.md deletion

- `build-task-workspace-leaf` no longer writes `done-criteria.md`.
- `ReadDoneCriteria` port + FS adapter deleted; `wire.ts` entry removed.
- `renderVerificationCriteriaSection` now emits `## Done criteria` (stable grep target).
- TUI `TasksPanel`: `taskCriteriaById: ReadonlyMap<string, readonly string[]>`
  replaces the async `readDoneCriteria` loader; ExecuteView builds the map from
  `taskState` (already polled). `parseCriteriaBullets` deleted.
- CLAUDE.md updated.

## Remaining

(none — the audit at `.claude/docs/audit/` is fully implemented as of this branch.)

## How to resume

1. Read the relevant island under `.claude/docs/audit/`.
2. Update this `NEXT-STEPS.md` as each step lands.
3. `/verify` must stay green between every step.
