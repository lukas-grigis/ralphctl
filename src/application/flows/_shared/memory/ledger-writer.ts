import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbsolutePath as AbsolutePathCtor } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { renderLearningsMd } from '@src/application/flows/_shared/memory/render-learnings-md.ts';
import {
  type LedgerLine,
  readLedgerLines,
  serializeLedgerBody,
  statLedgerExceedsThreshold,
} from '@src/application/flows/_shared/memory/read-ledger.ts';
import { type LedgerRow, compactLedger } from '@src/application/flows/_shared/memory/compact-ledger.ts';

/** Sibling `learnings.md` mirror name for a `learnings.ndjson` ledger path. */
const LEARNINGS_MD = 'learnings.md';

/**
 * Compute the `learnings.md` mirror path next to a `learnings.ndjson` ledger path. Pure.
 *
 * @public
 */
export const learningsMdPath = (ledgerPath: AbsolutePath): AbsolutePath | undefined => {
  const parsed = AbsolutePathCtor.parse(join(dirname(String(ledgerPath)), LEARNINGS_MD));
  return parsed.ok ? parsed.value : undefined;
};

/**
 * Regenerate the human-readable `learnings.md` mirror next to a ledger from an ALREADY-PARSED record
 * set. The canonical source of truth is always the NDJSON ledger; the markdown is a derived view, so
 * a regeneration failure is BEST-EFFORT — it is logged at warn and swallowed (the caller's primary
 * write to the ledger already succeeded; the mirror heals on the next render). Returns `Result.ok`
 * even on a swallowed mirror failure so callers never block on the derived artefact.
 *
 * Rendered LAZILY — NOT on the hot per-attempt append path — so the gen-eval critical path never
 * pays the O(n) read+reparse+rewrite the mirror used to cost. The two callers that DO regenerate it
 * are natural checkpoints a human is about to browse the file: the distill flow (`stampPromotedLeaf`)
 * and sprint close (`refreshMemoryMirrorLeaf`).
 *
 * @public
 */
export const mirrorLearningsMd = async (
  ledgerPath: AbsolutePath,
  records: readonly LearningRecord[],
  writeFile: WriteFile,
  log: Logger
): Promise<Result<void, never>> => {
  const mdPath = learningsMdPath(ledgerPath);
  if (mdPath === undefined) {
    log.warn('could not derive learnings.md path from ledger path', { path: String(ledgerPath) });
    return Result.ok(undefined);
  }
  const written = await writeFile(mdPath, renderLearningsMd(records));
  if (!written.ok) {
    log.warn('learnings.md mirror write failed (ledger is still authoritative)', {
      path: String(mdPath),
      error: written.error.message,
    });
  }
  return Result.ok(undefined);
};

/**
 * Compact the on-disk ledger IN PLACE when it has grown past the size threshold — the always-on
 * bounding step that runs regardless of whether the operator ever distills. A single cheap `fs.stat`
 * (`statLedgerExceedsThreshold`) gates the work: under the threshold this is one syscall and returns;
 * only once the ledger actually grows does it pay the read+compact+rewrite. NO `learnings.md` mirror
 * is rendered here — the mirror is lazy (see {@link mirrorLearningsMd}).
 *
 * Best-effort: a read or rewrite failure is logged and swallowed (`Result.ok`). The ledger stays
 * authoritative either way — an over-threshold file that fails to compact is merely larger than ideal,
 * never lost, and the next append retries the bound. Non-stamped rows are re-emitted from their
 * BYTE-FOR-BYTE raw line so unknown future fields survive the rewrite.
 *
 * @public
 */
export const boundLedgerIfNeeded = async (
  ledgerPath: AbsolutePath,
  deps: { readonly writeFile: WriteFile; readonly log: Logger }
): Promise<Result<void, never>> => {
  if (!(await statLedgerExceedsThreshold(ledgerPath))) return Result.ok(undefined);

  let collected: readonly LedgerLine[];
  try {
    collected = await readLedgerLines(ledgerPath, deps.log);
  } catch (cause) {
    deps.log.warn('ledger bounding skipped — could not read the ledger', {
      path: String(ledgerPath),
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return Result.ok(undefined);
  }
  // A malformed line means a corrupt ledger — refuse to compact (a rewrite would drop the bad row
  // silently). Leave it as-is; the size guard will keep flagging it for a human to inspect.
  const rows: LedgerRow[] = [];
  for (const { raw, record, parseError } of collected) {
    if (parseError !== undefined) {
      deps.log.warn('ledger bounding skipped — a line is malformed', { path: String(ledgerPath) });
      return Result.ok(undefined);
    }
    if (record === undefined) continue; // blank line — dropped from the rewrite
    rows.push({ raw, record });
  }

  const compacted = compactLedger(rows);
  if (compacted.evictedCount === 0 && compacted.deduplicatedCount === 0) return Result.ok(undefined);

  const body = serializeLedgerBody(compacted.rows);
  const written = await deps.writeFile(ledgerPath, body);
  if (!written.ok) {
    deps.log.warn('ledger bounding rewrite failed (ledger still authoritative)', {
      path: String(ledgerPath),
      error: written.error.message,
    });
    return Result.ok(undefined);
  }
  deps.log.info(
    `bounded ledger on append: ${rows.length}→${compacted.rows.length} rows (${compacted.deduplicatedCount} deduped, ${compacted.evictedCount} evicted)`,
    { path: String(ledgerPath) }
  );
  return Result.ok(undefined);
};

/**
 * Append one or more memory records (learnings AND/OR decisions) to the NDJSON ledger, then bound the
 * file if it has grown past the size threshold. The append is the authoritative, crash-safe operation
 * (one `AppendFile` call per record); the bound is the always-on size guard ({@link boundLedgerIfNeeded}).
 *
 * Deliberately does NOT regenerate the `learnings.md` mirror — that O(n) read+reparse+rewrite is the
 * cost this audit removed from the hot gen-eval path. The mirror is rendered lazily at distill /
 * sprint close instead (no in-loop consumer reads it; the generator reads the NDJSON via
 * `composePriorLearnings`).
 *
 * An append failure is returned as an error (the caller decides — `append-learnings` logs + continues
 * per its best-effort contract). The subsequent bound never fails the call.
 *
 * @public
 */
export const appendMemoryRecords = async (
  ledgerPath: AbsolutePath,
  records: readonly LearningRecord[],
  deps: { readonly appendFile: AppendFile; readonly writeFile: WriteFile; readonly log: Logger }
): Promise<Result<void, StorageError>> => {
  for (const record of records) {
    const appended = await deps.appendFile(ledgerPath, serializeLearningRecord(record));
    if (!appended.ok) return Result.error(appended.error);
  }
  await boundLedgerIfNeeded(ledgerPath, { writeFile: deps.writeFile, log: deps.log });
  return Result.ok(undefined) as Result<void, StorageError>;
};
