import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { isUuidv7 } from '@src/domain/value/uuid7.ts';
import { listDir, removeDir, renamePath } from '@src/integration/io/fs.ts';
import { parseIdFromName, NAME_SEPARATOR } from '@src/integration/persistence/storage.ts';
import { CURRENT_DATA_VERSION, writeDataVersion } from '@src/integration/persistence/data-migration/version-marker.ts';
import { backupDataDir } from '@src/integration/persistence/data-migration/backup.ts';
import { anyLockHeld } from '@src/integration/persistence/data-migration/lock-guard.ts';
import type { DryRunReport, MemoryMergePlan, RenamePlan } from '@src/integration/persistence/data-migration/types.ts';

const MEMORY_DIR = 'memory';
const LEARNINGS_NDJSON = 'learnings.ndjson';
const LEARNINGS_MD = 'learnings.md';

/**
 * Byte ceiling for the backfill ledger read — the integration-layer twin of the application layer's
 * `LEDGER_HARD_CEILING_BYTES` (50 MB). The application constant lives in a layer the integration code
 * cannot import, so the value is inlined here. A ledger past this is NOT read: a heap abort mid-backfill
 * must never be possible, and the runtime mirror (which applies the same ceiling) heals it on the next
 * append once compaction brings the file back under the limit.
 */
const MIRROR_BACKFILL_CEILING_BYTES = 50 * 1024 * 1024;

/**
 * Whether a `memory/` entry name is a trusted, in-tree entry the backfill may follow: either a bare
 * legacy `<uuidv7>` dir or an already-migrated `<uuidv7>--<slug>` dir. Any other name (e.g. a planted
 * symlink that is neither) is skipped so a backfill write can never be redirected outside the tree —
 * the same UUID/slugged-prefix gate the dry-run / `classifyMemoryEntry` applies.
 */
const isTrustedMemoryEntry = (name: string): boolean =>
  isUuidv7(name) || (name.includes(NAME_SEPARATOR) && isUuidv7(parseIdFromName(name)));

/**
 * Renderer for the `learnings.md` mirror, injected by the caller. The pure renderer lives in the
 * APPLICATION layer (`render-learnings-md.ts`) which the integration layer cannot import, so the
 * orchestrator threads it in here. It takes the raw NDJSON ledger body and returns the rendered
 * markdown, or `undefined` when the body has no renderable records (so the backfill skips the write).
 *
 * @public
 */
export type LearningsBackfillRenderer = (ndjsonBody: string) => string | undefined;

/**
 * Merge two raw NDJSON learnings-ledger bodies into one, de-duplicating by record `id`, and render
 * the accompanying `learnings.md`. Injected (like {@link LearningsBackfillRenderer}) because the
 * record parser / serializer / markdown renderer live in the APPLICATION layer the engine cannot
 * import. The adapter parses both bodies tolerantly (dropping blank / malformed rows), unions by id,
 * and returns the serialized ledger plus its markdown mirror (`md` is `undefined` when the union has
 * no renderable records). Pure — no I/O.
 *
 * @public
 */
export type LearningsMerger = (
  sluggedBody: string,
  legacyBody: string
) => { readonly ndjson: string; readonly md: string | undefined };

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
  /** Unions two ledger bodies (dedup by `id`) + renders the mirror — for the memory both-dirs merge. */
  readonly mergeLearnings: LearningsMerger;
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
 *  4. MERGES — for every memory both-dirs case, union the legacy ledger into the slugged one
 *     (dedup by record `id`), regenerate `learnings.md`, then remove the legacy dir. Like renames,
 *     a real I/O fault STOPS before the stamp (re-run resumes — the union is idempotent).
 *  5. BACKFILL — for every memory dir with a `learnings.ndjson` but no `learnings.md`, render and
 *     write the mirror. Best-effort: a backfill miss never fails the run.
 *  6. STAMP — write the version marker to {@link CURRENT_DATA_VERSION} with `lastWrittenByAppVersion`.
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

  // Memory both-dirs merges: union each legacy ledger into its slugged sibling (dedup by id), then
  // remove the legacy dir. Idempotent (an already-merged legacy dir is simply gone next run) and
  // gating like renames — a real I/O fault STOPS before the stamp so a re-run resumes safely.
  for (const merge of report.merges) {
    const outcome = await mergeOne(merge, ctx);
    if (!outcome.ok) {
      return { kind: 'failed', backupPath, error: outcome.error, applied };
    }
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
 * Resolve ONE memory both-dirs merge idempotently. Reads the legacy `learnings.ndjson` and the
 * slugged one, unions them (dedup by record `id`, via the injected {@link LearningsMerger}), writes
 * the merged ledger + regenerated `learnings.md` into the slugged dir, then removes the legacy dir.
 *
 * Idempotent: if the legacy dir is already gone (a prior run finished this merge), it is a no-op
 * success. A genuine I/O fault on the slugged write surfaces as a `StorageError` that stops the run
 * BEFORE the stamp; the legacy dir is removed only AFTER the merged ledger is durably written, so a
 * crash between the two leaves the legacy records still on disk and the next run re-merges them.
 */
const mergeOne = async (merge: MemoryMergePlan, ctx: ApplyCtx): Promise<Result<void, StorageError>> => {
  const legacyLedger = join(String(merge.legacyDir), LEARNINGS_NDJSON);
  if (!(await pathPresent(legacyLedger))) {
    // Legacy dir/ledger already gone (idempotent re-run) — nothing to merge. Drop any empty leftover.
    await removeDir(String(merge.legacyDir));
    return Result.ok(undefined) as Result<void, StorageError>;
  }

  const legacyBody = await readTextOrEmpty(legacyLedger);
  const sluggedLedger = join(String(merge.sluggedDir), LEARNINGS_NDJSON);
  const sluggedBody = await readTextOrEmpty(sluggedLedger);

  const { ndjson, md } = ctx.mergeLearnings(sluggedBody, legacyBody);

  const sluggedLedgerPath = AbsolutePath.parse(sluggedLedger);
  if (!sluggedLedgerPath.ok) {
    return Result.error(new StorageError({ subCode: 'io', message: `bad ledger path: ${sluggedLedger}` }));
  }
  const wrote = await ctx.writeFile(sluggedLedgerPath.value, ndjson);
  if (!wrote.ok) return Result.error(wrote.error);

  if (md !== undefined) {
    const mdPath = AbsolutePath.parse(join(String(merge.sluggedDir), LEARNINGS_MD));
    if (mdPath.ok) await ctx.writeFile(mdPath.value, md); // best-effort mirror; never blocks the merge
  }

  // Only NOW remove the legacy dir — the merged ledger is durably written, so a crash here just
  // re-merges (the union is idempotent: dedup by id collapses the re-added rows).
  const removed = await removeDir(String(merge.legacyDir));
  if (!removed.ok && removed.error instanceof StorageError) return Result.error(removed.error);
  return Result.ok(undefined) as Result<void, StorageError>;
};

const readTextOrEmpty = async (path: string): Promise<string> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * One-time backfill of `learnings.md` across all memory dirs. For each `<memory>/<dir>/` that has a
 * `learnings.ndjson` but no `learnings.md`, render the markdown from the ledger body and write it.
 * Best-effort throughout — an empty render, an unreadable ledger, or a failed write is swallowed and
 * never fails the migration; the runtime mirror heals it on the next append/promote.
 *
 * Two guards combine in the same loop:
 *  - SECURITY: only trusted in-tree entries ({@link isTrustedMemoryEntry} — a bare `<uuid>` or a
 *    slugged `<uuid>--<slug>`) are followed. A planted symlink whose name is neither is skipped, so a
 *    backfill write can never be redirected outside the data tree.
 *  - OOM: a single `fs.stat` precedes each read; a ledger past {@link MIRROR_BACKFILL_CEILING_BYTES}
 *    is skipped (never read), so a heap abort mid-backfill is impossible. The runtime mirror heals it.
 */
const backfillLearningsMd = async (dataRoot: AbsolutePath, ctx: ApplyCtx): Promise<void> => {
  const memoryRoot = join(String(dataRoot), MEMORY_DIR);
  const dirs = await listDir(memoryRoot);
  if (!dirs.ok) return;

  for (const dir of dirs.value) {
    if (!isTrustedMemoryEntry(dir)) continue; // untrusted name (possible symlink redirect) — skip
    const ledgerPath = join(memoryRoot, dir, LEARNINGS_NDJSON);
    const mdPath = join(memoryRoot, dir, LEARNINGS_MD);
    if (await ledgerExceedsCeiling(ledgerPath)) continue; // oversized — runtime mirror heals it
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

/** `fs.stat` the ledger; `true` when it is past the byte ceiling (so the caller skips the read). */
const ledgerExceedsCeiling = async (ledgerPath: string): Promise<boolean> => {
  try {
    const { size } = await fs.stat(ledgerPath);
    return size > MIRROR_BACKFILL_CEILING_BYTES;
  } catch {
    return false; // absent / unreadable → the read below handles it
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
