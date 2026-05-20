import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { LoadChainLog } from '@src/business/sprint/load-chain-log.ts';
import { parseChainLogLine } from '@src/business/sprint/parse-chain-log-line.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ChainLogEntry } from '@src/business/sprint/state-projection.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Build a {@link LoadChainLog} adapter that reads `<sprintDir>/chain.log` from disk and parses
 * each NDJSON line into a {@link ChainLogEntry}.
 *
 * Streaming would be nice for very large logs (the file-log sink writes append-only and never
 * truncates), but the snapshot renderer is called from well-defined moments (sprint start,
 * settle-attempt, sprint transition) — none of them is a hot path. A whole-file read keeps
 * the loader simple; if `chain.log` ever grows past a few MB we can revisit.
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
    try {
      raw = await fs.readFile(String(path), 'utf8');
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

    const entries: ChainLogEntry[] = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
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

    return Result.ok(entries);
  };
};
