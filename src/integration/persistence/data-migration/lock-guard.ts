import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { listDir } from '@src/integration/io/fs.ts';

const LOCKS_SUBDIR = 'locks';

/**
 * How fresh a lock's mtime must be to count as HELD. `proper-lockfile` heartbeats a live holder's
 * lock directory (default stale window 30s, refreshed ~3×), so a genuinely-held lock always has an
 * mtime within the stale window. A crashed holder stops heartbeating and its mtime ages past it; we
 * deliberately use a generous window (matching the file-locker default) so we never start a migration
 * that races a long-running implement flow, while still ignoring a stale crash-leftover lock.
 *
 * MUST stay in sync with `DEFAULT_STALE_AFTER_MS` in `integration/io/file-locker.ts` (currently 30_000):
 * if the locker's stale window changes, this one must move with it, or the migration's notion of "held"
 * diverges from the locker's notion of "live".
 */
const HELD_WITHIN_MS = 30_000;

/**
 * Whether ANY advisory flow lock is currently HELD under `<stateRoot>/locks/`. The migration's
 * `apply` step refuses to run while a lock is held — a rename must never race a running flow that has
 * a sprint dir path baked into its ctx (the user was burned by exactly this class of data corruption).
 *
 * A lock is a `proper-lockfile` directory (`repo-<hash>.lock`) whose mtime is heartbeated while its
 * holder is alive. We treat a lock as held when its mtime is within {@link HELD_WITHIN_MS}; an older
 * entry is a stale crash-leftover and is ignored. An absent / empty `locks/` dir ⇒ no lock held.
 *
 * @public
 */
export const anyLockHeld = async (stateRoot: AbsolutePath): Promise<boolean> => {
  const locksDir = join(String(stateRoot), LOCKS_SUBDIR);
  const entries = await listDir(locksDir);
  if (!entries.ok) return false;

  const now = Date.now();
  for (const name of entries.value) {
    if (!name.endsWith('.lock')) continue;
    let mtimeMs: number;
    try {
      ({ mtimeMs } = await fs.stat(join(locksDir, name)));
    } catch {
      continue; // vanished between listdir and stat — not held
    }
    if (now - mtimeMs <= HELD_WITHIN_MS) return true;
  }
  return false;
};
