import { lstat, mkdir, readdir, readlink, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/**
 * Subdirectory under each AI session's working directory where Claude
 * Code (and Copilot, by convention) looks for project-scoped skills.
 */
export const SKILLS_SUBDIR = join('.claude', 'skills');

/**
 * `SessionSkillsLinker` — manages the lifecycle of `.claude/skills/<name>`
 * symlinks pointing into a shared `cache/skills/` directory.
 *
 * The chain definition wires `link(sessionDir, names)` before spawning
 * an AI session and `unlink(sessionDir)` after the session exits, so a
 * crashed phase never leaves stale links behind.
 */
export interface SessionSkillsLinker {
  /**
   * Create symlinks for each requested skill under
   * `<sessionDir>/.claude/skills/<name>`. Skills not present in the
   * cache are skipped silently — the caller already validated the cache
   * via {@link SkillsSyncer.syncDefaults}; a missing skill at this layer
   * is operator-edited state and we honour their absence.
   */
  link(sessionDir: AbsolutePath, skills: readonly string[]): Promise<Result<void, StorageError>>;

  /**
   * Remove every symlink we created under `<sessionDir>/.claude/skills/`.
   * Idempotent — a second call is a no-op. Non-symlink entries (the
   * user replaced one with a real file) are left intact.
   */
  unlink(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
}

export interface FileSessionSkillsLinkerOptions {
  /** Root the linker resolves skill names against — usually `cache/skills/`. */
  readonly cacheSkillsDir: AbsolutePath;
}

export class FileSessionSkillsLinker implements SessionSkillsLinker {
  private readonly cacheSkillsDir: AbsolutePath;

  constructor(opts: FileSessionSkillsLinkerOptions) {
    this.cacheSkillsDir = opts.cacheSkillsDir;
  }

  async link(sessionDir: AbsolutePath, skills: readonly string[]): Promise<Result<void, StorageError>> {
    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    try {
      await mkdir(skillsDir, { recursive: true });
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to create skills dir ${skillsDir}: ${stringifyError(err)}`,
          path: skillsDir,
          cause: err,
        })
      );
    }

    for (const name of skills) {
      const source = join(this.cacheSkillsDir, name);
      const linkPath = join(skillsDir, name);

      // Pre-existing entry handling:
      //  - symlink → unlink first so we always end up pointing at the
      //    current source (re-runs after a refresh).
      //  - file/dir → leave it alone. Do not destroy user data.
      try {
        const existing = await lstat(linkPath);
        if (existing.isSymbolicLink()) {
          await unlink(linkPath);
        } else {
          // Entry exists and isn't a symlink — skip silently. The
          // operator owns the contents.
          continue;
        }
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT') {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to inspect ${linkPath}: ${stringifyError(err)}`,
              path: linkPath,
              cause: err,
            })
          );
        }
      }

      try {
        await symlink(source, linkPath, 'dir');
      } catch (err) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to symlink ${source} → ${linkPath}: ${stringifyError(err)}`,
            path: linkPath,
            cause: err,
          })
        );
      }
    }
    return Result.ok();
  }

  async unlink(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch (err) {
      const code = errnoCode(err);
      // Missing dir is a no-op — caller may unlink before any link.
      if (code === 'ENOENT' || code === 'ENOTDIR') return Result.ok();
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to list ${skillsDir}: ${stringifyError(err)}`,
          path: skillsDir,
          cause: err,
        })
      );
    }

    for (const name of entries) {
      const linkPath = join(skillsDir, name);
      try {
        const stats = await lstat(linkPath);
        if (!stats.isSymbolicLink()) continue;
        // Defence in depth — re-read the link target. If readlink
        // fails (e.g. dangling), we still want to unlink the entry.
        try {
          await readlink(linkPath);
        } catch {
          // fall through; unlink will tolerate a dangling link.
        }
        await unlink(linkPath);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOENT') continue;
        // Best-effort — return the first hard failure so the caller
        // has something to surface, but don't try to "rollback" a
        // partial cleanup.
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `failed to unlink ${linkPath}: ${stringifyError(err)}`,
            path: linkPath,
            cause: err,
          })
        );
      }
    }
    return Result.ok();
  }
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
