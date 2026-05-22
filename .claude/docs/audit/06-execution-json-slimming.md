# 06 — `execution.json` (and `tasks.json`) slimming

**Status:** decided-change (2026-05-22)
**Related:
** [01 logs dir](01-logs-directory-layout.md), [03 truncation](03-truncation-policy.md), [04 setup-script lifecycle](04-setup-script-failure.md)

## Decision

Remove `stdoutTailBytes` and `stderrTailBytes` from `SetupRun` (`execution.json`) and `VerifyRun` (`tasks.json`). The
audit row keeps **only** structured metadata; the raw output lives in `<sprintDir>/logs/...`
per [01](01-logs-directory-layout.md), untruncated.

## New shapes

### `SetupRun` (in `execution.json`)

```ts
// src/domain/entity/sprint-execution.ts
export interface SetupRun {
  readonly repositoryId: RepositoryId;
  readonly ranAt: IsoTimestamp;
  readonly command: string; // exact command run — used for drift detection ([04])
  readonly exitCode: number; // -1 on spawn-error
  readonly durationMs: number;
  readonly outcome: SetupRunOutcome; // 'success' | 'failed' | 'spawn-error' | 'skipped'
  // REMOVED: stdoutTailBytes, stderrTailBytes
}
```

### `VerifyRun` (in `tasks.json`)

```ts
// src/domain/entity/task.ts (analogous)
export interface VerifyRun {
  readonly phase: 'pre' | 'post';
  readonly ranAt: IsoTimestamp;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outcome: VerifyRunOutcome;
  // REMOVED: stdoutTailBytes, stderrTailBytes
}
```

The audit row remains JSON-portable, small, fast to read. The output body is on disk, untruncated, where it belongs.

## Where the output lives (per [01](01-logs-directory-layout.md))

```
<sprintDir>/logs/setup/<repo-id>.log
<sprintDir>/logs/verify/<task-id>/pre-attempt-<N>.log
<sprintDir>/logs/verify/<task-id>/post-attempt-<N>.log
```

**Naming convention is the discoverability story** — no `logPath` field on the audit row. The reader derives the path
from `repositoryId` + (for verify) attempt number, both of which are already on neighbouring data structures. One less
field to keep in sync; one less broken pointer to worry about.

### Setup-script naming under the [04](04-setup-script-failure.md) lifecycle

Under [04](04-setup-script-failure.md)'s policy, setup runs at most once per repo per sprint (resume skips repos that
already have a `success` entry; re-runs are explicit operator actions). So the simple `logs/setup/<repo-id>.log` is
unambiguous:

- First run, success → file written; subsequent invocations skip and don't touch it.
- First run, failure → file written with the failing output; operator fixes environment, re-runs → file is **overwritten
  ** with the new run's output.

Overwrite is acceptable because re-runs are explicit operator actions (forcing the leaf to retry that repo). If we ever
want a per-attempt history for setup, append a `.attempt-<N>.log` suffix later — defer until someone asks.

### Verify-script naming

Verify is multi-attempt by design (pre + post per attempt, N attempts per task). The full convention:

- `logs/verify/<task-id>/pre-attempt-<N>.log` — pre-task verify, attempt `N`
- `logs/verify/<task-id>/post-attempt-<N>.log` — post-task verify, attempt `N`

`N` matches the attempt number on the Task (the same `n` field already in `Task.attempts[n].n`). Reader can stitch the
file to the audit row through the attempt number.

## Backwards compatibility — handled via per-entity migrations

The same versioning + migration pattern from [09](09-ai-session-contract.md) extends to persisted entities. Each
repository owns a `schemaVersion` and a `migrations` map. The `stdoutTailBytes` / `stderrTailBytes` removal becomes a
tiny migration step rather than a "no compat" cliff.

```ts
// src/integration/persistence/sprint-execution/migrations.ts (proposed)
export const SPRINT_EXECUTION_SCHEMA_VERSION = 1;

export const sprintExecutionMigrations: Record<number, (raw: unknown) => unknown> = {
  // 0 → 1: drop the embedded stdout/stderr tail fields; bodies live in <sprintDir>/logs/ now
  0: (raw) => {
    const next = structuredClone(raw) as Record<string, unknown> & { setupRanAt?: Array<Record<string, unknown>> };
    for (const run of next.setupRanAt ?? []) {
      delete run.stdoutTailBytes;
      delete run.stderrTailBytes;
    }
    return next;
  },
};
```

Repository load flow (same shape as the [09](09-ai-session-contract.md) validator):

```ts
// src/integration/persistence/sprint-execution/repository.ts (load() sketch)
const raw = JSON.parse(await readFile(path));
const fileVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
let current: unknown = raw;
for (let v = fileVersion; v < SPRINT_EXECUTION_SCHEMA_VERSION; v++) {
  const step = sprintExecutionMigrations[v];
  if (!step) return Result.error(new MigrationGapError({ from: v, to: SPRINT_EXECUTION_SCHEMA_VERSION, file: path }));
  current = step(current);
}
const parsed = sprintExecutionSchema.safeParse(current);
// ... Zod-validates the final shape against the current SprintExecution schema
```

**Net effect:** in-flight sprints upgrade transparently. The "no migration" worry from earlier conversations dissolves —
migration is cheap (one delete per field) and automatic.

Each domain entity gets the same treatment:

- `sprint-execution` (this island) — version 1 drops `stdoutTailBytes` / `stderrTailBytes`
- `task` — version 1 drops `VerifyRun.stdoutTailBytes` / `stderrTailBytes` (see action items)
- `sprint` / `settings` — bump only when their shape changes

## Open questions

(none — all sub-decisions absorbed
by [01](01-logs-directory-layout.md), [03](03-truncation-policy.md), [04](04-setup-script-failure.md))

## Action items

- [ ] Remove `stdoutTailBytes` and `stderrTailBytes` from the `SetupRun` and `VerifyRun` types in the relevant domain
      entity files (sprint-execution + task).
- [ ] Strip the `tailBytes(...)` call site in `setup-script-runner.ts` (covered by [03](03-truncation-policy.md)'s
      action to delete `script-tail-bytes.ts`).
- [ ] Strip equivalent call sites in the verify leaves.
- [ ] In the setup leaf, after the shell runner returns, write the full output to
      `<sprintDir>/logs/setup/<repo-id>.log` (atomic write). On failure, the file still gets written before the leaf returns
      `Result.error`.
- [ ] In the verify leaves, write the full output to `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log`.
      Atomic write; do not block the chain on persistence failures (log warn).
- [ ] Update TUI banner / log rendering: where it used to read `stdoutTailBytes` from the audit row, read the last N
      bytes of the log file instead (lazy, on hover / expand). Display clip per [03](03-truncation-policy.md).
- [ ] Update the JSON-shape sections of `.claude/docs/ARCHITECTURE.md` to drop the removed fields.
- [ ] Tests: golden-file tests for `SetupRun` / `VerifyRun` JSON encoding that assert the fields are gone.
- [ ] **Repository migrations:** add `schemaVersion` (literal `1` for the post-migration shape) + `<entity>Migrations`
      map per persisted entity (sprint-execution, task, sprint, settings). Wire the version-walk loop into each repository's
      `load()` path. Reuse `MigrationGapError` from [09](09-ai-session-contract.md).
- [ ] Provide a single shared helper (e.g. `src/integration/persistence/_engine/run-migrations.ts`) so each repository's
      load path is one line of "walk migrations + Zod-parse" rather than reimplementing the loop.

## Evidence

- `src/domain/entity/sprint-execution.ts` — `SetupRun` shape
- `src/domain/entity/task.ts` — `VerifyRun` shape inside attempts
- `src/integration/persistence/sprint-execution/repository.ts` — saver
- `src/integration/persistence/task/repository.ts` — saver
- `src/application/flows/implement/leaves/setup-script-runner.ts:192–204` — current `tailBytes` call site
- `src/application/flows/implement/leaves/pre-task-verify.ts`, `post-task-verify.ts` — equivalents on the verify side
