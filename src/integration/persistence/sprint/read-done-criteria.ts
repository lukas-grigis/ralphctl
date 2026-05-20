import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { ReadDoneCriteria } from '@src/business/sprint/read-done-criteria.ts';

/**
 * Build a {@link ReadDoneCriteria} adapter that reads
 * `<sprintDir>/implement/<taskId>/done-criteria.md` from disk.
 *
 * The file is authored by `build-task-workspace-leaf` once per task at implement-start. Before
 * the per-task subchain runs, the file does not exist — the adapter returns `undefined` rather
 * than surfacing a `StorageError`, because the TUI consumer treats "not yet materialised" as a
 * normal state (the canonical criteria still live on `Task.verificationCriteria`).
 *
 * Other IO errors (permission denied, EIO) also degrade to `undefined`: the panel renders an
 * informational fallback in either case, and the TUI must never crash because the audit
 * directory is unreadable.
 *
 * @public
 */
export const createFsReadDoneCriteria = (): ReadDoneCriteria => {
  return async (sprintDir, taskId) => {
    const path = join(String(sprintDir), 'implement', taskId, 'done-criteria.md');
    try {
      return await fs.readFile(path, 'utf8');
    } catch (cause) {
      if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) {
        return undefined;
      }
      // Permission denied / EIO — return undefined so the TUI degrades gracefully. The canonical
      // criteria still live on `Task.verificationCriteria` if the operator opens the task detail.
      return undefined;
    }
  };
};
