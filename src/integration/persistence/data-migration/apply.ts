import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { listDir, renamePath } from '@src/integration/io/fs.ts';
import { CURRENT_DATA_VERSION, writeDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import { backupDataDir } from '@src/integration/persistence/data-migration/backup.ts';
import { anyLockHeld } from '@src/integration/persistence/data-migration/lock-guard.ts';
import type { DryRunReport, RenamePlan } from '@src/integration/persistence/data-migration/types.ts';

const MEMORY_DIR = 'memory';
const LEARNINGS_NDJSON = 'learnings.ndjson';
const LEARNINGS_MD = 'learnings.md';

/**
 * Renderer for the `learnings.md` mirror, injected by the caller. The pure renderer lives in the
 * APPLICATION layer (`render-learnings-md.ts`) which the integration layer cannot import, so the
 * orchestrator threads it in here. It takes the raw NDJSON ledger body and returns the rendered
 * markdown, or `undefined` when the body has no renderable records (so the backfill skips the write).
 *
 * @public
 */
export type LearningsBackfillRenderer = (ndjsonBody: string) => string | undefined;

/** Atomic write port, injected so the engine stays free of a hard dependency on a concrete writer. */
export type ApplyWriteFile = (path: AbsolutePath, content: string) => Promise<Result<void, StorageError>>;

/**
 * Inputs the apply step needs beyond the dry-run report: the single clock read for the run (drives
 * both the backup dir name and the marker), the app version to stamp, the state root (for the lock
 * guard), the markdown renderer, and the atomic writer.
 *
 * @public
 */
export interface ApplyCtx {
  /** ISO timestamp for this run — folded into the backup dir name AND the version marker. */
  readonly timestamp: string;
  /** The ralphctl version stamping the marker — named by a future failure screen for downgrade. */
  readonly appVersion: string;
  /** `<appRoot>/state` — checked for held advisory locks before any rename. */
  readonly stateRoot: AbsolutePath;
  /** Renders `learnings.md` from an NDJSON body during backfill. */
  readonly renderLearnings: LearningsBackfillRenderer;
  /** Atomic file writer for the backfilled `learnings.md`. */
  readonly writeFile: ApplyWriteFile;
}

/** One rename's outcome — for the splash + the audit trail. */
export interface AppliedRename {
  readonly id: string;
  readonly fromName: string;
  readonly toName: string;
  /** `renamed` — moved this run; `skipped` — target already present or source already gone. */
  readonly status: 'renamed' | 'skipped';
}

/**
 * The result of an apply run. A discriminated union so the caller (Wave 2b) routes each outcome to
 * the right screen:
 *  - `ok`        — every planned rename done (or idempotently skipped), `learnings.md` backfilled,
 *                  marker stamped to CURRENT.
 *  - `lock-held` — a flow is running; nothing was touched. Re-offer next launch.
 *  - `failed`    — a rename threw mid-run (or the backup/stamp failed); the marker was NOT stamped
 *                  (so a re-run resumes safely), and the `backupPath` is carried so the failure
 *                  screen can name the rollback dir.
 *
 * @public
 */
export type ApplyResult =
  | { readonly kind: 'ok'; readonly backupPath: string; readonly applied: readonly AppliedRename[] }
  | { readonly kind: 'lock-held' }
  | {
      readonly kind: 'failed';
      readonly backupPath: string | undefined;
      readonly error: StorageError;
      readonly applied: readonly AppliedRename[];
    };

/**
 * Execute a migration from a {@link DryRunReport}. Strict order, each step gating the next:
 *
 *  1. LOCK GUARD — refuse (`lock-held`, nothing touched) if any advisory lock is held under
 *     `state/locks/`. A rename must never race a running flow.
 *  2. BACKUP — full recursive copy of `data/` to a timestamped sibling, VERIFIED present before any
 *     rename. If the backup fails, return `failed` (no `backupPath`) — nothing was renamed yet.
 *  3. RENAMES — one atomic `renamePath(from, to)` per PLANNED item, IDEMPOTENTLY: if the target
 *     already exists or the source is already gone, record `skipped` and continue. A rename that
 *     THROWS a real I/O fault STOPS the run: return `failed` carrying the backup path WITHOUT
 *     stamping the marker, so the next launch resumes cleanly (already-done renames skip).
 *  4. BACKFILL — for every memory dir with a `learnings.ndjson` but no `learnings.md`, render and
 *     write the mirror. Best-effort: a backfill miss never fails the run.
 *  5. STAMP — write the version marker to {@link CURRENT_DATA_VERSION} with `lastWrittenByAppVersion`.
 *     Written ONLY after every rename succeeded, so it is the single commit point of the migration.
 *
 * Skips and problems from the dry-run never abort the run — only a thrown rename or a failed
 * backup/stamp does. The `problems` list is informational; those entries are left in their legacy
 * form (tolerant readers still serve them).
 *
 * @public
 */
export const apply = async (dataRoot: AbsolutePath, report: DryRunReport, ctx: ApplyCtx): Promise<ApplyResult> => {
  if (await anyLockHeld(ctx.stateRoot)) {
    return { kind: 'lock-held' };
  }

  const backup = await backupDataDir(dataRoot, 1, ctx.timestamp);
  if (!backup.ok) {
    return { kind: 'failed', backupPath: undefined, error: backup.error, applied: [] };
  }
  const backupPath = backup.value;

  const applied: AppliedRename[] = [];
  for (const plan of report.planned) {
    const outcome = await applyOne(plan);
    if (!outcome.ok) {
      // A rename threw a real I/O fault — STOP. Do NOT stamp; the re-run resumes (done renames skip).
      return { kind: 'failed', backupPath, error: outcome.error, applied };
    }
    applied.push(outcome.value);
  }

  await backfillLearningsMd(dataRoot, ctx);

  const stamp = await writeDataVersion(dataRoot, {
    dataVersion: CURRENT_DATA_VERSION,
    lastWrittenByAppVersion: ctx.appVersion,
  });
  if (!stamp.ok) {
    // Every rename succeeded but the marker write failed — surface it as a failure. The next launch
    // re-runs (all renames are no-ops) and re-attempts the stamp.
    return { kind: 'failed', backupPath, error: stamp.error, applied };
  }

  return { kind: 'ok', backupPath, applied };
};

/**
 * Apply ONE planned rename idempotently. If the target is already present (a prior crashed run did
 * this one) or the source is already gone, it is a no-op `skipped`. A `StorageError` from the rename
 * is a real fault that stops the whole run; a `NotFoundError` (source vanished in the stat→rename
 * race) is an idempotent skip.
 */
const applyOne = async (plan: RenamePlan): Promise<Result<AppliedRename, StorageError>> => {
  const fromExists = await pathPresent(String(plan.from));
  const toExists = await pathPresent(String(plan.to));

  if (toExists || !fromExists) {
    return Result.ok(skipped(plan)) as Result<AppliedRename, StorageError>;
  }

  const renamed = await renamePath(String(plan.from), String(plan.to));
  if (!renamed.ok) {
    if (renamed.error instanceof StorageError) return Result.error(renamed.error);
    return Result.ok(skipped(plan)) as Result<AppliedRename, StorageError>; // NotFoundError → idempotent skip
  }
  return Result.ok({ id: plan.id, fromName: plan.fromName, toName: plan.toName, status: 'renamed' }) as Result<
    AppliedRename,
    StorageError
  >;
};

const skipped = (plan: RenamePlan): AppliedRename => ({
  id: plan.id,
  fromName: plan.fromName,
  toName: plan.toName,
  status: 'skipped',
});

/**
 * One-time backfill of `learnings.md` across all memory dirs. For each `<memory>/<dir>/` that has a
 * `learnings.ndjson` but no `learnings.md`, render the markdown from the ledger body and write it.
 * Best-effort throughout — an empty render, an unreadable ledger, or a failed write is swallowed and
 * never fails the migration; the runtime mirror heals it on the next append/promote.
 */
const backfillLearningsMd = async (dataRoot: AbsolutePath, ctx: ApplyCtx): Promise<void> => {
  const memoryRoot = join(String(dataRoot), MEMORY_DIR);
  const dirs = await listDir(memoryRoot);
  if (!dirs.ok) return;

  for (const dir of dirs.value) {
    const ledgerPath = join(memoryRoot, dir, LEARNINGS_NDJSON);
    const mdPath = join(memoryRoot, dir, LEARNINGS_MD);
    if (!(await pathPresent(ledgerPath))) continue;
    if (await pathPresent(mdPath)) continue; // already has a mirror — leave it

    let body: string;
    try {
      body = await fs.readFile(ledgerPath, 'utf8');
    } catch {
      continue;
    }
    const md = ctx.renderLearnings(body);
    if (md === undefined) continue;
    const parsed = AbsolutePath.parse(mdPath);
    if (!parsed.ok) continue;
    await ctx.writeFile(parsed.value, md); // best-effort — ignore the result
  }
};

const pathPresent = async (path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
};
