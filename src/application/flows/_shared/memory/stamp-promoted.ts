import { promises as fs } from 'node:fs';
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
import {
  type LearningRecord,
  parseLearningLine,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';

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
  /** Merge the stamp outcome (count of records stamped) into ctx. */
  readonly output: (ctx: TCtx, stampedCount: number) => TCtx;
}

/**
 * Final step of the Theme 6 distill flow: durably mark accepted learnings as promoted so they are
 * never proposed again. Reads the entire ledger, flips `promotedAt` from `null` to the
 * distillation timestamp for every record whose id is in the accepted set, leaves all other
 * records byte-for-byte, then rewrites the whole file atomically via the {@link WriteFile} port.
 *
 * Full read-modify-WRITE (not append): an append could only add rows, but stamping mutates
 * existing rows, so the file is rebuilt. The {@link WriteFile} adapter is atomic in production
 * (write-temp + rename), so a concurrent reader never sees a half-stamped ledger.
 *
 * Empty accepted set → no-op (still `Result.ok`, no write): the operator declined every proposal.
 * Absent ledger → no-op: there is nothing to stamp (the loader would already have proposed
 * nothing). Aborted read → re-propagate `AbortError` so cancellation is not swallowed.
 *
 * Only records whose id is in `acceptedIds` AND currently `promotedAt === null` are stamped; an
 * already-promoted record (or one the operator didn't accept) is preserved unchanged, so a stamp
 * is idempotent and never back-dates a prior promotion.
 *
 * @public
 */
export const stampPromotedLeaf = <TCtx>(
  deps: StampPromotedLeafDeps,
  config: StampPromotedLeafConfig<TCtx>
): Element<TCtx> =>
  leaf<TCtx, { readonly path: AbsolutePath; readonly acceptedIds: readonly string[] }, number>(LEAF_NAME, {
    useCase: {
      execute: async (input, signal) => stamp(deps, input.path, input.acceptedIds, signal),
    },
    input: (ctx) => ({ path: config.path(ctx), acceptedIds: config.acceptedIds(ctx) }),
    output: (ctx, stampedCount) => config.output(ctx, stampedCount),
  });

const stamp = async (
  deps: StampPromotedLeafDeps,
  path: AbsolutePath,
  acceptedIds: readonly string[],
  signal: AbortSignal | undefined
): Promise<Result<number, DomainError>> => {
  const log = deps.logger.named('memory.stamp-promoted');

  const accepted = new Set(acceptedIds);
  if (accepted.size === 0) {
    log.info('no accepted learnings — nothing to stamp');
    return Result.ok(0);
  }

  let raw: string;
  try {
    raw = await fs.readFile(String(path), { encoding: 'utf8', ...(signal ? { signal } : {}) });
  } catch (cause) {
    if (isAbortedRead(cause, signal)) {
      return Result.error(new AbortError({ elementName: LEAF_NAME }));
    }
    // Absent ledger → nothing to stamp. (The loader would already have proposed nothing, so an
    // accepted set against a missing ledger is a no-op rather than an error.)
    log.info('no learnings ledger to stamp', { path: String(path) });
    return Result.ok(0);
  }

  const promotedAt = String(deps.clock());
  const records: LearningRecord[] = [];
  let stampedCount = 0;
  for (const line of raw.split('\n')) {
    const parsed = parseLearningLine(line);
    if (!parsed.ok) {
      // A malformed line cannot be safely round-tripped through a rewrite — fail loudly rather
      // than dropping a row the operator can't see.
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: 'cannot stamp learnings.ndjson — a line is malformed',
          path: String(path),
          cause: parsed.error,
        })
      );
    }
    const record = parsed.value;
    if (record === undefined) continue; // blank line — drop from the rewrite
    if (accepted.has(record.id) && record.promotedAt === null) {
      records.push({ ...record, promotedAt });
      stampedCount += 1;
    } else {
      records.push(record);
    }
  }

  const body = records.map(serializeLearningRecord).join('');
  const written = await deps.writeFile(path, body);
  if (!written.ok) return Result.error(written.error);

  log.info(`stamped ${stampedCount} learning(s) promoted`, { path: String(path), stampedCount });
  return Result.ok(stampedCount);
};

/**
 * True when a thrown read error is the result of an aborted `AbortSignal`. Node surfaces this as
 * an `Error` with `name === 'AbortError'` and `code === 'ABORT_ERR'`.
 */
const isAbortedRead = (cause: unknown, signal: AbortSignal | undefined): boolean => {
  if (signal?.aborted === true) return true;
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') return true;
    if ((cause as { code?: unknown }).code === 'ABORT_ERR') return true;
  }
  return false;
};
