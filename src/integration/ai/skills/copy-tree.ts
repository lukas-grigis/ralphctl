/**
 * `copyTree` — recursively copy a directory tree of real files. Used by
 * `BundledSkillsCopier` to materialise the bundled `default/` + per-phase
 * skill folders into a session's `<cwd>/.claude/skills/` directory.
 *
 * Symlinks pointing at files are resolved and their underlying file is
 * copied — the destination tree is freestanding and edit-safe by design.
 * No symlinks are ever written to the destination.
 *
 * Symlinks pointing at directories (and other non-file targets) are
 * rejected as a `StorageError` rather than silently skipped: a circular
 * dir-symlink in the source would otherwise either disappear from the
 * destination or trigger unbounded recursion. Callers that legitimately
 * need dir-symlink semantics should resolve the link themselves.
 *
 * On I/O failure mid-walk the destination is left in a partial state.
 * The caller (`BundledSkillsCopier`) is idempotent on a partial
 * destination — its `uninstall` path only removes entries it actually
 * tracked at install time, so the caller's next run heals the gap.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';

export async function copyTree(src: string, dst: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dst, { recursive: true });
    const dirents = await readdir(src, { withFileTypes: true });
    for (const d of dirents) {
      const s = join(src, d.name);
      const t = join(dst, d.name);
      if (d.isDirectory()) {
        const r = await copyTree(s, t);
        if (!r.ok) return r;
      } else if (d.isFile()) {
        await copyFile(s, t);
      } else if (d.isSymbolicLink()) {
        const stats = await stat(s);
        if (!stats.isFile()) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `copy-tree: symlink target is not a regular file: ${s}`,
              path: s,
            })
          );
        }
        await copyFile(s, t);
      }
    }
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to copy ${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}`,
        path: dst,
        cause: err,
      })
    );
  }
}
