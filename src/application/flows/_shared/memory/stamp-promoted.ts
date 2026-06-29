import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { isAbortedRead } from '@src/application/flows/_shared/memory/abort-guard.ts';
import {
  type LedgerLine,
  readLedgerLines,
  statLedgerExceedsThreshold,
} from '@src/application/flows/_shared/memory/read-ledger.ts';
import { type LedgerRow, compactLedger } from '@src/application/flows/_shared/memory/compact-ledger.ts';
import { mirrorLearningsMd } from '@src/application/flows/_shared/memory/ledger-writer.ts';

const LEAF_NAME = 'stamp-promoted';

export interface StampPromotedLeafDeps {
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

/**
 * Pure ctx contract for {@link stampPromotedLeaf}. The flow author wires the ledger path and the
 * set of accepted record ids (the ones the operator confirmed for promotion) in from ctx.
 */
export interface StampPromotedLeafConfig<TCtx> {
  /** Resolve the absolute ledger path at execute time. */
  readonly path: (ctx: TCtx) => AbsolutePath;
  /** Ids of the learnings the operator accepted — only these are stamped `promotedAt`. */
  readonly acceptedIds: (ctx: TCtx) => readonly string[];
  /**
   * Ids of the learnings the operator was shown but did NOT accept — stamped `retiredAt` so they
   * durably leave the candidate pool and are never re-proposed. Optional (a flow with no decline
   * path omits it). A retired id wins over accepted-and-retired only as a programmer error;
   * callers MUST pass disjoint sets (accepted = proposed ∩ confirmed, retired = proposed − confirmed).
   */
  readonly retiredIds?: (ctx: TCtx) => readonly string[];
  /** Merge the stamp outcome (count of records stamped `promotedAt`) into ctx. */
  readonly output: (ctx: TCtx, stampedCount: number) => TCtx;
}

/**
 * Final step of the distill flow: durably mark accepted learnings as promoted so they are
 * never proposed again, AND keep the ledger bounded. Reads the entire ledger
 * ({@link readLedgerLines} — whole-file with a one-syscall byte-ceiling safety net), flips
 * `promotedAt` from `null` to the distillation timestamp for every record whose id is in the
 * accepted set, leaves all other records byte-for-byte, compacts the result to a bounded
 * de-duplicated set ({@link compactLedger}), then rewrites the whole file atomically via the
 * {@link WriteFile} port.
 *
 * Full read-modify-WRITE (not append): an append could only add rows, but stamping mutates
 * existing rows and compaction prunes them, so the file is rebuilt. The {@link WriteFile} adapter
 * is atomic in production (write-temp + rename), so a concurrent reader never sees a half-written
 * ledger.
 *
 * Also stamps `retiredAt` (the durable rejection state) on every id in `retiredIds` — the candidates
 * the operator was shown but did NOT accept — so a declined learning permanently leaves the prompt
 * candidate pool and is never re-proposed, instead of riding `{{PRIOR_LEARNINGS}}` indefinitely.
 *
 * Empty accepted+retired set → CONDITIONAL: if the ledger is below the size threshold
 * ({@link statLedgerExceedsThreshold}) it stays a no-op (still `Result.ok`, no write) — there is no
 * disposition to record and no growth to reclaim. But if the ledger has grown past the threshold, a
 * compaction-only pass runs and rewrites the bounded file EVEN WITH NOTHING stamped, so an
 * unattended ledger can never grow without bound.
 *
 * Absent ledger → no-op: there is nothing to stamp (the loader would already have proposed
 * nothing). Aborted read → re-propagate `AbortError` so cancellation is not swallowed. A malformed
 * line → `StorageError`: a corrupt ledger is refused rather than silently dropped through a
 * rewrite.
 *
 * Only records whose id is in `acceptedIds`/`retiredIds` AND currently `promotedAt === null` (and,
 * for retirement, not already retired) are stamped; an already-settled record (or one the operator
 * neither accepted nor declined) is preserved unchanged, so a stamp is idempotent and never
 * back-dates a prior disposition. Non-stamped rows — including compaction winners — are written from
 * their ORIGINAL RAW LINE so unknown future fields round-trip intact.
 *
 * @public
 */
export const stampPromotedLeaf = <TCtx>(
  deps: StampPromotedLeafDeps,
  config: StampPromotedLeafConfig<TCtx>
): Element<TCtx> =>
  leaf<
    TCtx,
    { readonly path: AbsolutePath; readonly acceptedIds: readonly string[]; readonly retiredIds: readonly string[] },
    number
  >(LEAF_NAME, {
    useCase: {
      execute: async (input, signal) => stamp(deps, input.path, input.acceptedIds, input.retiredIds, signal),
    },
    input: (ctx) => ({
      path: config.path(ctx),
      acceptedIds: config.acceptedIds(ctx),
      retiredIds: config.retiredIds?.(ctx) ?? [],
    }),
    output: (ctx, stampedCount) => config.output(ctx, stampedCount),
  });

const stamp = async (
  deps: StampPromotedLeafDeps,
  path: AbsolutePath,
  acceptedIds: readonly string[],
  retiredIds: readonly string[],
  signal: AbortSignal | undefined
): Promise<Result<number, DomainError>> => {
  const log = deps.logger.named('memory.stamp-promoted');

  const accepted = new Set(acceptedIds);
  // A declined id that is ALSO accepted (shouldn't happen — callers pass disjoint sets) defers to
  // promotion, so subtract the accepted set defensively.
  const retired = new Set([...retiredIds].filter((id) => !accepted.has(id)));

  // CHANGED semantic: an empty accepted+retired set is no longer an unconditional no-op. If the
  // ledger has grown past the size threshold we still run a compaction-only pass so an unattended
  // ledger can never grow without bound; below the threshold (the common case) it stays a cheap no-op.
  if (accepted.size === 0 && retired.size === 0 && !(await statLedgerExceedsThreshold(path))) {
    log.info('no accepted/retired learnings and ledger under threshold — nothing to stamp');
    return Result.ok(0);
  }

  // Read the whole ledger into memory as {raw, record} rows, then stamp + compact. The reader's
  // byte-ceiling guard rotates a pathologically-huge file aside (yielding an empty list) so this
  // never loads tens of MB; below the ceiling the collected array is bounded by the subsequent
  // compaction.
  let collected: readonly LedgerLine[];
  try {
    collected = await readLedgerLines(path, log, signal);
  } catch (cause) {
    if (isAbortedRead(cause, signal)) {
      return Result.error(new AbortError({ elementName: LEAF_NAME }));
    }
    // Absent ledger → nothing to stamp. (The loader would already have proposed nothing, so an
    // accepted set against a missing ledger is a no-op rather than an error.)
    log.info('no learnings ledger to stamp', { path: String(path) });
    return Result.ok(0);
  }

  if (collected.length === 0) {
    log.info('no learnings ledger to stamp', { path: String(path) });
    return Result.ok(0);
  }

  const stampTime = String(deps.clock());
  const stamped = stampPass(collected, accepted, retired, stampTime, path);
  if (!stamped.ok) return Result.error(stamped.error);
  const { rows, stampedCount } = stamped.value;

  // Compact to a bounded, de-duplicated set. Winners are carried by their raw line, so byte-for-
  // byte forward-compat holds across the dedup; promoted tombstones are never evicted.
  const compacted = compactLedger(rows);

  const body = compacted.rows.map((r) => ensureTrailingNewline(r.raw)).join('');
  const written = await deps.writeFile(path, body);
  if (!written.ok) return Result.error(written.error);

  // Regenerate the human-readable learnings.md mirror from the post-compaction record set so the
  // promote/dedup is reflected in the browsable view. Best-effort — a mirror failure never fails the
  // stamp (the NDJSON ledger is authoritative). Rows whose parse was dropped on a blank line carry
  // no record; the compactor only retains real records, so every retained row has one.
  const mirrorRecords = compacted.rows.flatMap((r) => (r.record === undefined ? [] : [r.record]));
  await mirrorLearningsMd(path, mirrorRecords, deps.writeFile, log);

  log.info(
    `compacted ledger: ${rows.length}→${compacted.rows.length} rows (${compacted.deduplicatedCount} deduped, ${compacted.evictedCount} evicted)`,
    {
      path: String(path),
      stampedCount,
      before: rows.length,
      after: compacted.rows.length,
      deduped: compacted.deduplicatedCount,
      evicted: compacted.evictedCount,
    }
  );
  return Result.ok(stampedCount);
};

/**
 * The stamp pass over the collected ledger lines. Re-serializes ONLY rows that change disposition
 * this pass: an accepted-and-unpromoted row gets `promotedAt`, a declined-and-still-live row gets
 * `retiredAt`. Every other row — including blank-line drops aside — is carried through by its
 * byte-for-byte raw line. A malformed line short-circuits to a `StorageError`: a corrupt ledger is
 * refused rather than silently rewritten/compacted over.
 *
 * Promotion wins over retirement for the same id (the accepted check runs first), but callers pass
 * disjoint sets so this only matters defensively. `stampedCount` counts PROMOTIONS only (the leaf's
 * historical contract); retirements are a side effect of the same pass.
 */
const stampPass = (
  collected: readonly LedgerLine[],
  accepted: ReadonlySet<string>,
  retired: ReadonlySet<string>,
  stampTime: string,
  path: AbsolutePath
): Result<{ rows: LedgerRow[]; stampedCount: number }, StorageError> => {
  const rows: LedgerRow[] = [];
  let stampedCount = 0;
  for (const { raw, record, parseError } of collected) {
    if (parseError !== undefined) {
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: 'cannot stamp learnings.ndjson — a line is malformed',
          path: String(path),
          cause: parseError,
        })
      );
    }
    if (record === undefined) continue; // blank line — drop from the rewrite
    if (accepted.has(record.id) && record.promotedAt === null) {
      // Only a stamped row is re-serialized from the parsed (schema-projected) record. Pre-set the
      // promotedAt on BOTH raw and record so compaction sees the stamped row as a tombstone.
      const stamped = { ...record, promotedAt: stampTime };
      rows.push({ raw: serializeLearningRecord(stamped), record: stamped });
      stampedCount += 1;
      continue;
    }
    if (retired.has(record.id) && record.promotedAt === null && isLive(record)) {
      // Durable rejection: stamp `retiredAt` so the row leaves the candidate pool for good. Like a
      // promotion it is re-serialized from the parsed record and becomes a compaction tombstone.
      const stamped = { ...record, retiredAt: stampTime };
      rows.push({ raw: serializeLearningRecord(stamped), record: stamped });
      continue;
    }
    // Preserve every other row BYTE-FOR-BYTE from its original line. The schema is a plain
    // `z.object` that STRIPS unknown keys on parse, so re-serializing a non-stamped record would
    // silently delete any field a newer ralphctl version added — destroying data an older pinned
    // binary was only meant to tolerate. The compactor carries this raw line through; a compaction
    // WINNER is likewise represented by its raw line, never re-serialized.
    rows.push({ raw, record });
  }
  return Result.ok({ rows, stampedCount });
};

/** Not already retired (so a second decline never re-serializes / re-dates an existing tombstone). */
const isLive = (record: LearningRecord): boolean => record.retiredAt === undefined || record.retiredAt === null;

/**
 * `readLedgerLines` strips the trailing newline off each raw line (`split('\n')`);
 * `serializeLearningRecord` keeps it. Normalise so the NDJSON rewrite is one well-formed line per
 * row regardless of source.
 */
const ensureTrailingNewline = (raw: string): string => (raw.endsWith('\n') ? raw : `${raw}\n`);
