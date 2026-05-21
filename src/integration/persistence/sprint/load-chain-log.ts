import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { LoadChainLog } from '@src/business/sprint/load-chain-log.ts';
import { parseChainLogLine } from '@src/business/sprint/parse-chain-log-line.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ChainLogEntry } from '@src/business/sprint/state-projection.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Hard cap on the bytes we read from the tail of `chain.log` before parsing. Bounds RAM AND
 * parse time when the file has accreted across a long-running sprint (every implement-style run
 * appends a chain-run section; rate-limit retries, watchdog kills, and round-by-round trace
 * entries inflate the line count). The snapshot renderer is called after every settled attempt,
 * so a 100 MB+ chain.log on a long-running sprint would otherwise re-read the whole file on
 * every round.
 *
 * 8 MiB is generous enough to cover every chain run in a normal sprint (the file-log sink keeps
 * each event ≤ a few KB; thousands of recent events still fit) while preventing the file from
 * becoming a memory amplifier. Past this point the snapshot reflects only the recent activity —
 * which is fine because the renderer is already a *snapshot* over what fits, not a full history.
 */
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Read at most `maxBytes` from the END of a file. Returns the read buffer plus a `truncated`
 * flag indicating whether the caller's reading window started past byte 0. The first line of a
 * truncated read is partial by construction (mid-line cut) so the caller drops it.
 */
const readFileTail = async (path: string, maxBytes: number): Promise<{ raw: string; truncated: boolean }> => {
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= maxBytes) {
      const raw = await fs.readFile(path, 'utf8');
      return { raw, truncated: false };
    }
    const start = size - maxBytes;
    const buf = Buffer.allocUnsafe(maxBytes);
    await handle.read(buf, 0, maxBytes, start);
    return { raw: buf.toString('utf8'), truncated: true };
  } finally {
    await handle.close();
  }
};

/**
 * Build a {@link LoadChainLog} adapter that reads `<sprintDir>/chain.log` from disk and parses
 * each NDJSON line into a {@link ChainLogEntry}.
 *
 * Reads at most the last {@link MAX_TAIL_BYTES} bytes of the file so a long-running sprint's
 * append-only log cannot turn the snapshot renderer into a memory amplifier — the renderer is
 * invoked after every settled attempt, so re-reading 100 MB on every round would dominate the
 * harness's RSS. When the file is truncated, the first (partial) line is dropped — better to
 * miss one event than feed a malformed line to the parser.
 *
 * Malformed lines are skipped silently — the renderer must remain renderable from a partial
 * log. A `logger` can be supplied to surface the dropped-line count without changing the
 * function's return shape.
 *
 * @public
 */
export const createFsChainLogLoader = (deps: { readonly logger?: Logger } = {}): LoadChainLog => {
  return async (path) => {
    let raw: string;
    let truncated: boolean;
    try {
      const read = await readFileTail(String(path), MAX_TAIL_BYTES);
      raw = read.raw;
      truncated = read.truncated;
    } catch (cause) {
      if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) {
        return Result.ok([]);
      }
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to read chain.log: ${String(path)}`,
          path: String(path),
          cause,
        })
      );
    }

    const lines = raw.split('\n');
    // Drop the first line of a truncated read — the byte window starts mid-line by construction,
    // so the first split-fragment is incomplete and would either parse as a malformed JSON (a
    // counted drop, surfacing in the warn log) or as garbage skipped silently. Discarding it
    // up front keeps the dropped-line count honest.
    const startIdx = truncated ? 1 : 0;
    const entries: ChainLogEntry[] = [];
    let dropped = 0;
    for (let i = startIdx; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const entry = parseChainLogLine(line);
      if (entry === undefined) {
        // Distinguish blank/boundary (expected) from JSON-parse failures (worth logging). The
        // parser returns undefined for both; we count only lines that LOOK like JSON.
        const trimmed = line.trim();
        if (trimmed.length > 0 && trimmed.startsWith('{')) dropped++;
        continue;
      }
      entries.push(entry);
    }

    if (dropped > 0) {
      deps.logger?.named('sprint.chain-log').warn(`dropped ${String(dropped)} malformed chain.log line(s)`, {
        path: String(path),
        dropped,
      });
    }

    if (truncated) {
      deps.logger?.named('sprint.chain-log').debug('chain.log tail-read (file exceeded cap)', {
        path: String(path),
        capBytes: MAX_TAIL_BYTES,
      });
    }

    return Result.ok(entries);
  };
};
