import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { listDir } from '@src/integration/io/fs.ts';
import { DEFAULT_STALE_AFTER_MS } from '@src/integration/io/file-locker.ts';

const LOCKS_SUBDIR = 'locks';

/**
 * How fresh a lock's mtime must be to count as HELD. `proper-lockfile` heartbeats a live holder's
 * lock directory (default stale window {@link DEFAULT_STALE_AFTER_MS}, refreshed ~3×), so a
 * genuinely-held lock always has an mtime within the stale window. A crashed holder stops
 * heartbeating and its mtime ages past it; we deliberately reuse the same generous window the
 * file-locker itself uses so we never start a migration that races a long-running implement flow,
 * while still ignoring a stale crash-leftover lock.
 *
 * Imported (not re-declared) so this can never drift from the locker's actual stale-reclaim
 * window — a caller passing a non-default `staleAfterMs` to `createFileLocker` is a separate,
 * narrower gap this alone doesn't close (see the audit note in the file-locker module).
 */
const HELD_WITHIN_MS: number = DEFAULT_STALE_AFTER_MS;

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
      // `lstat`, not `stat`: read the entry itself rather than following it, so a symlinked lock entry
      // cannot masquerade as a fresh lock by pointing at a recently-touched file elsewhere.
      ({ mtimeMs } = await fs.lstat(join(locksDir, name)));
    } catch {
      continue; // vanished between listdir and lstat — not held
    }
    if (now - mtimeMs <= HELD_WITHIN_MS) return true;
  }
  return false;
};
