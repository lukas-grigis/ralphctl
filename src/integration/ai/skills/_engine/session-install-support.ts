/**
 * Per-session install bookkeeping shared by the filesystem skills adapter and the filesystem
 * agent-definition adapter (`agents/_engine/` reaches in via the `_engine`-to-`_engine` seam).
 */

import { existsSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';

const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    await rmdir(path);
  } catch {
    // Non-empty or missing — both are fine, the cleanup is best-effort.
  }
};

export interface SessionInstallManifestOptions {
  readonly providerId: string;
  /** Top-level directory the CLI scans, e.g. `.claude`. */
  readonly parentDir: string;
  /** Managed subdirectory under `parentDir`, e.g. `skills`. */
  readonly subdir: string;
  /** What the uninstall failure message calls the entries, e.g. `agent definitions`. */
  readonly noun: string;
  readonly logger: Logger | undefined;
}

export interface SessionInstallManifest {
  /** `<parentDir>/<subdir>`, relative to a session dir. */
  readonly managedSubdir: string;
  /**
   * Run `write` against the session's tracked set — entries it adds stay tracked even when it then
   * fails, so uninstall still cleans them — then keep `ralphctl-*` out of `git status`.
   */
  install(
    sessionDir: AbsolutePath,
    write: (tracked: Set<string>) => Promise<Result<void, StorageError>>
  ): Promise<Result<void, StorageError>>;
  /** Remove every tracked entry (`entryPath` resolves one), then tidy the parents if now empty. */
  uninstall(
    sessionDir: AbsolutePath,
    entryPath: (sessionDir: string, entry: string) => string
  ): Promise<Result<void, StorageError>>;
}

export const createSessionInstallManifest = (opts: SessionInstallManifestOptions): SessionInstallManifest => {
  // Not promised across crashed runs — the cleanup is best-effort.
  const installed = new Map<string, Set<string>>();
  const managedSubdir = join(opts.parentDir, opts.subdir);
  // The exclude write is idempotent anyway; this set only avoids re-reading it on every install.
  const excludeAttempted = new Set<string>();

  /**
   * Best-effort exclude line in the session's common git dir (a linked worktree resolves to the
   * main repo's `.git`). A non-git tree or a write-protected exclude warns and proceeds.
   */
  const ensureExcludeOnce = async (sessionDir: AbsolutePath): Promise<void> => {
    if (excludeAttempted.has(String(sessionDir))) return;
    excludeAttempted.add(String(sessionDir));
    const excluded = await ensureGitExcludeWildcard(sessionDir, `${managedSubdir}/ralphctl-*`);
    if (!excluded.ok) {
      opts.logger
        ?.named(`${opts.subdir}.exclude`)
        .warn(`${opts.providerId}: failed to update .git/info/exclude: ${excluded.error.message}`);
    }
  };

  /**
   * A per-task subchain failing between install and uninstall would otherwise leak its entry for
   * the harness lifetime (`sequential` has no try/finally), so drop sessions whose dir is gone.
   */
  const pruneMissingSessionDirs = (): void => {
    for (const key of [...installed.keys()]) {
      if (!existsSync(key)) installed.delete(key);
    }
  };

  return {
    managedSubdir,

    async install(sessionDir, write) {
      pruneMissingSessionDirs();
      const key = String(sessionDir);
      const tracked = installed.get(key) ?? new Set<string>();
      const written = await write(tracked);
      if (tracked.size > 0) installed.set(key, tracked);
      if (!written.ok) return written;
      await ensureExcludeOnce(sessionDir);
      return Result.ok(undefined);
    },

    async uninstall(sessionDir, entryPath) {
      const key = String(sessionDir);
      const tracked = installed.get(key);
      if (tracked === undefined || tracked.size === 0) return Result.ok(undefined);

      const managedDir = join(key, managedSubdir);
      try {
        for (const entry of tracked) {
          await rm(entryPath(key, entry), { recursive: true, force: true });
        }
        installed.delete(key);
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${opts.providerId}: failed to uninstall ${opts.noun} under ${managedDir}: ${messageOf(cause)}`,
            path: managedDir,
            cause,
          })
        );
      }

      // A non-empty parent (a project `.github/` with workflows in it) survives.
      await tryRmdirIfEmpty(managedDir);
      await tryRmdirIfEmpty(join(key, opts.parentDir));
      return Result.ok(undefined);
    },
  };
};
