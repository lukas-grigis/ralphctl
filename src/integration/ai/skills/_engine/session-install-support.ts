/**
 * Session-install helpers shared by the filesystem skills adapter and the filesystem
 * agent-definition adapter (`agents/_engine/` reaches in via the `_engine`-to-`_engine` seam).
 */

import { existsSync } from 'node:fs';
import { rmdir } from 'node:fs/promises';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';

export const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    await rmdir(path);
  } catch {
    // Non-empty or missing — both are fine, the cleanup is best-effort.
  }
};

interface GitExcludeOnceOptions {
  readonly excludePattern: string;
  readonly providerId: string;
  readonly logger: Logger | undefined;
  /** Logger scope for the failure warning, e.g. `'skills.exclude'`. */
  readonly logName: string;
}

/**
 * Best-effort, once-per-`sessionDir` attempt to append the wildcard exclude line to the
 * `info/exclude` of `<sessionDir>`'s common git dir (a linked worktree resolves to the main
 * repo's `.git`). A non-git tree, an uninspectable `.git`, or a write-protected exclude file
 * all collapse to "warn and proceed" — the caller's install already succeeded regardless.
 */
export const createGitExcludeOnce = (opts: GitExcludeOnceOptions): ((sessionDir: AbsolutePath) => Promise<void>) => {
  // The file write is idempotent anyway; this set only avoids re-reading it on every install.
  const attempted = new Set<string>();
  return async (sessionDir) => {
    const key = String(sessionDir);
    if (attempted.has(key)) return;
    attempted.add(key);

    const excluded = await ensureGitExcludeWildcard(sessionDir, opts.excludePattern);
    if (!excluded.ok) {
      opts.logger
        ?.named(opts.logName)
        .warn(`${opts.providerId}: failed to update .git/info/exclude: ${excluded.error.message}`);
    }
  };
};

/**
 * Drop manifest entries whose sessionDir no longer exists. The leak path is a per-task subchain
 * failing between link and unlink — `sequential` skips the unlink and the chain has no
 * try/finally, so the entry would otherwise stick for the harness lifetime.
 */
export const pruneMissingSessionDirs = (installed: Map<string, unknown>): void => {
  for (const key of [...installed.keys()]) {
    if (!existsSync(key)) installed.delete(key);
  }
};
