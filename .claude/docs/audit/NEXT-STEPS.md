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

### Step 5 groundwork

- Optional `outputDir` field on `AiSession`.
- Codex interactive `-a on-request` → `-a never`.
- ESLint port-name regex extended with `Contract$`.

### Step 7 (partial) — `<sprintDir>/logs/` writes

- `setupScriptRunnerLeaf` writes `<sprintDir>/logs/setup/<repo-id>.log`.
- `preTaskVerifyLeaf` / `postTaskVerifyLeaf` write
  `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log`.
- `runVerifyScriptUseCase` returns `{ run, rawOutput }` so the leaf has the full body.
- New tests on `setupScriptRunnerLeaf` cover success / failure / no-sprintDir paths.

### Step 9 — [05] / [08] done-criteria.md deletion

- `build-task-workspace-leaf` no longer writes `done-criteria.md`.
- `ReadDoneCriteria` port + FS adapter deleted; `wire.ts` entry removed.
- `renderVerificationCriteriaSection` now emits `## Done criteria` (stable grep target).
- TUI `TasksPanel`: `taskCriteriaById: ReadonlyMap<string, readonly string[]>`
  replaces the async `readDoneCriteria` loader; ExecuteView builds the map from
  `taskState` (already polled). `parseCriteriaBullets` deleted.
- CLAUDE.md updated.

## Remaining

The work below was scoped but not landed. Each block names its blocker so the next
implementer can pick the right place to start.

### Step 5 — per-leaf migration to the audit-[09] contract

Per-leaf `<leaf>.contract.ts` files compose the `_engine/` building blocks; each
leaf switches from `consumeSignals` to `validateSignalsFile + renderSidecars`.

- Leaves to migrate: `generator`, `evaluator`, `refine`, `plan`, `ideate`, `readiness`.
- Per leaf: declare `<leaf>.contract.ts`, update prompt template to substitute
  `{{OUTPUT_CONTRACT_SECTION}}`, add the 9-branch test grid with the mock provider.
- Wire `--add-dir <sprintDir>` for implement-only spawns.
- Update `commit-task` to read `commit-message` from ctx (drop `Attempt.commitMessage`).
- Wire `RALPHCTL_DEBUG_TRACE` env-var read in `wire()`.
- Update skills adapter for bare-name installs (readiness-generated `setup` / `verify`).
- Delete `parseHarnessSignals` + `signals/_engine/parse-signals.ts` + friends.
- ESLint fence: chain-layer rule blocking `contract/signals/**` imports outside
  `_engine/`. `fs.appendFile` ban outside `integration/io/` (lands with step 6).

Blocker: the production providers still parse stdout and write `signals.json` as
a top-level array. Per-leaf contracts include a `migrations[0]` that wraps the
array into `{ schemaVersion: 1, signals: [...] }` so legacy data continues to
load. Once every leaf migrates, providers drop the stdout parser and write
nothing — the AI's `Write` tool emits `signals.json` directly.

### Step 6 — [07] progress.md journal model

Depends on step 5 (signals come from validated `signals.json` per spawn, not
from chain.log mining).

- Add `AppendFile` port at `src/business/io/append-file.ts` + integration adapter.
- Replace `write-progress-snapshot.ts` snapshotting with a `progress-journal-leaf`
  that appends one section per task-attempt settlement.
- Delete `state-projection.ts`, `load-chain-log.ts`, `load-decisions-log.ts`,
  `decisions-log-sink.ts`.
- `file-log-sink.ts` becomes opt-in via `RALPHCTL_DEBUG_TRACE=1` writing to
  `<sprintDir>/events.ndjson` (not under `logs/`).
- Delete `ralphctl sprint regenerate-progress` CLI command.
- Add separator-line writes to activate / review / done transitions.
- Add `## Prior progress` section to implement / refine / plan / ideate prompt templates.
- Drop the `<!-- machine:begin -->` JSON tail on `progress.md`.

### Step 7 remainder — entity slimming + migrations

- Remove `stdoutTailBytes` / `stderrTailBytes` from `SetupRun` and `VerifyRun`.
- Add `schemaVersion` + per-entity `migrations` map on every persisted entity
  (sprint-execution, task, sprint, settings).
- Provide shared `src/integration/persistence/_engine/run-migrations.ts` helper.
- TUI banner / log rendering: lazy-read the last N bytes of the matching log
  file on hover / expand instead of from the audit row.

### Step 8 — [03] truncation sweep

- Delete `src/domain/value/script-tail-bytes.ts` and every `tailBytes(...)` call site.
- Delete `SINK_BODY_CAP` (and `decisions-log-sink.ts` itself per step 6).
- Apply display-clip marker rule (`…` / `▼ more`) at every TUI clip site.
- Audit banner-clip unit (bytes vs code-units vs graphemes).

## How to resume

1. Read the relevant island under `.claude/docs/audit/`.
2. Update this `NEXT-STEPS.md` as each step lands.
3. `/verify` must stay green between every step.
