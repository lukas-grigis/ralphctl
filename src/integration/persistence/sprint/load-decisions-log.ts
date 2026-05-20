import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { LoadDecisionsLog } from '@src/business/sprint/load-decisions-log.ts';
import { parseDecisionsLogLine } from '@src/business/sprint/parse-decisions-log-line.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { DecisionEntry } from '@src/business/sprint/state-projection.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Build a {@link LoadDecisionsLog} adapter that reads `<sprintDir>/decisions.log` and parses
 * each positional line into a {@link DecisionEntry}.
 *
 * Like `createFsChainLogLoader`, this is a whole-file read — the file is small (one line per
 * decision; AI agents are told to emit decisions sparingly) and the snapshot renderer is
 * not on a hot path.
 *
 * Malformed lines are skipped silently so a single corrupted entry can't block the snapshot.
 * A `logger` can be supplied to surface the dropped-line count without changing the function's
 * return shape.
 *
 * @public
 */
export const createFsDecisionsLogLoader = (deps: { readonly logger?: Logger } = {}): LoadDecisionsLog => {
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
          message: `failed to read decisions.log: ${String(path)}`,
          path: String(path),
          cause,
        })
      );
    }

    const entries: DecisionEntry[] = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const entry = parseDecisionsLogLine(line);
      if (entry === undefined) {
        dropped++;
        continue;
      }
      entries.push(entry);
    }

    if (dropped > 0) {
      deps.logger?.named('sprint.decisions-log').warn(`dropped ${String(dropped)} malformed decisions.log line(s)`, {
        path: String(path),
        dropped,
      });
    }

    return Result.ok(entries);
  };
};
