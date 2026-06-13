import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { type LearningRecord, parseLearningLine } from '@src/application/flows/_shared/memory/learning-record.ts';

/**
 * One streamed ledger line: the ORIGINAL raw text (no trailing newline — readline strips it),
 * the parsed record (or `undefined` for a blank line), and the parse error (or `undefined` when
 * the line parsed cleanly). Exactly one of `record` / `parseError` is meaningful per non-blank
 * line; a blank line yields `record === undefined && parseError === undefined`.
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

const STREAM_NAME = 'stream-ledger';

/** Estimated average bytes per NDJSON ledger row — used only by {@link statLedgerExceedsThreshold}. */
const ESTIMATED_ROW_BYTES = 300;

/**
 * Hard cap on total rows retained on disk after compaction (tombstones + pending). Shared with
 * `compactLedger`. Exported here so the streaming threshold check and the compactor agree.
 *
 * @public
 */
export const LEDGER_MAX_ROWS = 500;

/**
 * Stream a learnings NDJSON ledger line-by-line without loading the whole file into RAM. Each
 * non-blank line is parsed eagerly (so the caller never re-parses), but the raw line is preserved
 * for byte-for-byte rewrites.
 *
 * Resolution of the three line outcomes:
 *  - blank line → `{ raw, record: undefined, parseError: undefined }`;
 *  - clean parse → `{ raw, record, parseError: undefined }`;
 *  - malformed line → `{ raw, record: undefined, parseError }` — the caller decides skip vs fail.
 *
 * ENOENT (absent ledger) → the generator yields NOTHING and returns; an absent ledger is the
 * common case and callers treat the empty stream as an empty ledger.
 *
 * AbortSignal: if the signal is already aborted at entry, or fires mid-stream, the underlying
 * read stream is destroyed and an {@link AbortError} is thrown (per the SECURITY.md "a cancelled
 * read must re-propagate AbortError, never collapse into an empty ledger" rule).
 *
 * @public
 */
export async function* streamLedgerLines(
  path: AbsolutePath,
  signal?: AbortSignal
): AsyncGenerator<LedgerLine, void, void> {
  if (isAborted(signal)) throw new AbortError({ elementName: STREAM_NAME });

  const stream = createReadStream(String(path), { encoding: 'utf8' });

  // A late ENOENT surfaces as an 'error' event on the stream; readline rejects the async-iterator
  // with it. We catch below and treat ENOENT as an empty ledger.
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  const onAbort = (): void => {
    rl.close();
    stream.destroy();
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const raw of rl) {
      if (isAborted(signal)) throw new AbortError({ elementName: STREAM_NAME });
      const parsed = parseLearningLine(raw);
      if (!parsed.ok) {
        yield { raw, record: undefined, parseError: parsed.error };
        continue;
      }
      yield { raw, record: parsed.value, parseError: undefined };
    }
  } catch (cause) {
    if (isAborted(signal)) throw new AbortError({ elementName: STREAM_NAME });
    if (isEnoent(cause)) return; // absent ledger → empty stream
    throw cause;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    rl.close();
    stream.destroy();
  }
}

/** Read the live `aborted` flag through a function so TS does not over-narrow it across `await`. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const isEnoent = (cause: unknown): boolean => cause instanceof Error && (cause as { code?: unknown }).code === 'ENOENT';

/**
 * Cheap pre-check: estimate whether the on-disk ledger is large enough to warrant a compaction
 * pass, WITHOUT reading it. `fs.stat` gives the byte size; rows are estimated as
 * `size / ESTIMATED_ROW_BYTES`. Returns `true` once the estimate reaches 90% of
 * {@link LEDGER_MAX_ROWS}, so compaction kicks in slightly before the hard cap is hit rather than
 * exactly at it.
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
