import { promises as fs } from 'node:fs';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type LearningRecord, parseLearningLine } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';

/**
 * One ledger line: the ORIGINAL raw text (no trailing newline — `split('\n')` strips it), the
 * parsed record (or `undefined` for a blank line), and the parse error (or `undefined` when the
 * line parsed cleanly). Exactly one of `record` / `parseError` is meaningful per non-blank line;
 * a blank line yields `record === undefined && parseError === undefined`.
 *
 * The `raw` field is the BYTE-FOR-BYTE source line. Callers that rewrite the ledger must re-emit
 * non-stamped rows from `raw` (not from a re-serialized `record`) so unknown future fields a newer
 * ralphctl version added survive a round-trip — see {@link parseLearningLine} for why the schema
 * strips unknown keys.
 *
 * @public
 */
export interface LedgerLine {
  readonly raw: string;
  readonly record: LearningRecord | undefined;
  readonly parseError: ParseError | undefined;
}

/** Estimated average bytes per NDJSON ledger row — used only by {@link statLedgerExceedsThreshold}. */
const ESTIMATED_ROW_BYTES = 300;

/**
 * Hard cap on total rows retained on disk after compaction (tombstones + pending). Shared with
 * `compactLedger`.
 *
 * @public
 */
export const LEDGER_MAX_ROWS = 500;

/**
 * Absolute byte ceiling for the on-disk ledger — the safety net for a pathologically-huge
 * pre-existing file. At ~300 bytes/row a healthy compacted ledger is well under 200 KB, so 50 MB
 * is orders of magnitude past anything compaction ever allows; reaching it means the file is
 * corrupt or was never compacted (e.g. produced by a buggy build). Rather than load tens of MB of
 * NDJSON into RAM to process it, {@link readLedgerLines} rotates such a file aside and starts fresh.
 *
 * @public
 */
export const LEDGER_HARD_CEILING_BYTES = 50 * 1024 * 1024;

/** Read the live `aborted` flag through a function so TS does not over-narrow it across `await`. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const isEnoent = (cause: unknown): boolean => cause instanceof Error && (cause as { code?: unknown }).code === 'ENOENT';

/**
 * Read a learnings NDJSON ledger whole-file and parse it into {@link LedgerLine}s. Each non-blank
 * line is parsed eagerly (so the caller never re-parses), and the raw line is preserved for
 * byte-for-byte rewrites.
 *
 * Per-line resolution:
 *  - blank line → `{ raw, record: undefined, parseError: undefined }`;
 *  - clean parse → `{ raw, record, parseError: undefined }`;
 *  - malformed line → `{ raw, record: undefined, parseError }` — the caller decides skip vs fail.
 *
 * Safety net (byte ceiling): a single cheap `fs.stat` runs before the read. If the file is larger
 * than {@link LEDGER_HARD_CEILING_BYTES} — far past anything compaction ever produces — it is NOT
 * loaded. Instead it is rotated aside (best-effort `rename` to `<path>.bak`) and the ledger is
 * treated as EMPTY (an empty array), so the surrounding flow starts fresh rather than OOMing on a
 * pathologically-huge corrupt file. The rotation is logged at `warn`.
 *
 * ENOENT (absent ledger) → an empty array; an absent ledger is the common case and callers treat
 * it as an empty ledger.
 *
 * AbortSignal: an already-aborted signal at entry, or a `stat`/`readFile` that rejects with an
 * abort, re-propagates as the underlying rejection (the caller's `isAbortedRead` guard converts it
 * to `AbortError`). A cancelled read must never collapse into an empty ledger.
 *
 * @public
 */
export const readLedgerLines = async (
  path: AbsolutePath,
  log: Logger,
  signal?: AbortSignal
): Promise<readonly LedgerLine[]> => {
  let raw: string;
  try {
    if (await rotateIfOverCeiling(path, log, signal)) return [];
    raw = await fs.readFile(String(path), { encoding: 'utf8', signal });
  } catch (cause) {
    if (isAborted(signal)) throw cause;
    if (isEnoent(cause)) return []; // absent ledger → empty
    throw cause;
  }

  return raw.split('\n').map(toLedgerLine);
};

const toLedgerLine = (raw: string): LedgerLine => {
  const parsed = parseLearningLine(raw);
  if (!parsed.ok) return { raw, record: undefined, parseError: parsed.error };
  return { raw, record: parsed.value, parseError: undefined };
};

/**
 * Cheap one-syscall guard: `fs.stat` the ledger and, if it exceeds {@link LEDGER_HARD_CEILING_BYTES},
 * rotate it aside (best-effort `rename` to `<path>.bak`) and return `true` so the caller treats the
 * ledger as empty. Below the ceiling — or absent (ENOENT) — returns `false` and the caller reads
 * normally. A failed rename is logged but still returns `true`: we refuse to load a file past the
 * ceiling regardless of whether the rotation succeeded.
 */
const rotateIfOverCeiling = async (path: AbsolutePath, log: Logger, signal?: AbortSignal): Promise<boolean> => {
  let size: number;
  try {
    ({ size } = await fs.stat(String(path), { bigint: false }));
  } catch (cause) {
    if (isAborted(signal)) throw cause;
    if (isEnoent(cause)) return false; // absent → read path handles ENOENT
    throw cause;
  }

  if (size <= LEDGER_HARD_CEILING_BYTES) return false;

  const backup = `${String(path)}.bak`;
  log.warn(`learnings ledger exceeded ${LEDGER_HARD_CEILING_BYTES} bytes; rotated to .bak and starting fresh`, {
    path: String(path),
    backup,
    size,
    ceiling: LEDGER_HARD_CEILING_BYTES,
  });
  try {
    await fs.rename(String(path), backup);
  } catch (cause) {
    if (isAborted(signal)) throw cause;
    // Best-effort: a failed rotation must not block the flow. We still treat the ledger as empty.
    log.warn('could not rotate oversized learnings ledger aside', {
      path: String(path),
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return true;
};

/**
 * Cheap pre-check: estimate whether the on-disk ledger is large enough to warrant a compaction
 * pass, WITHOUT reading it. `fs.stat` gives the byte size; rows are estimated as
 * `size / ESTIMATED_ROW_BYTES`. Returns `true` once the estimate reaches 90% of
 * {@link LEDGER_MAX_ROWS}, so compaction kicks in slightly before the hard cap is hit rather than
 * exactly at it.
 *
 * This is a ROW-COUNT concern, distinct from the {@link LEDGER_HARD_CEILING_BYTES} byte ceiling in
 * {@link readLedgerLines}: it decides whether an empty-accepted stamp pass should still run a
 * compaction-only rewrite, whereas the ceiling decides whether the file is safe to read at all.
 *
 * An absent ledger (`ENOENT`) — or any stat failure — returns `false`: there is nothing to
 * compact, and a stat error must never block the surrounding flow.
 *
 * @public
 */
export const statLedgerExceedsThreshold = async (path: AbsolutePath): Promise<boolean> => {
  try {
    const { size } = await fs.stat(String(path));
    const estimatedRows = size / ESTIMATED_ROW_BYTES;
    return estimatedRows >= LEDGER_MAX_ROWS * 0.9;
  } catch {
    return false;
  }
};

/**
 * `readLedgerLines` strips the trailing newline off each raw line (`split('\n')`);
 * `serializeLearningRecord` keeps it. Normalise so the NDJSON rewrite is one well-formed line per
 * row regardless of source.
 */
export const ensureTrailingNewline = (raw: string): string => (raw.endsWith('\n') ? raw : `${raw}\n`);

/**
 * Join compacted ledger rows into a well-formed NDJSON body. Shared by both ledger-rewrite paths
 * (`stampPromotedLeaf` and `boundLedgerIfNeeded`) so they emit byte-for-byte-identical output for
 * the same input rows.
 */
export const serializeLedgerBody = (rows: ReadonlyArray<{ readonly raw: string }>): string =>
  rows.map((r) => ensureTrailingNewline(r.raw)).join('');
