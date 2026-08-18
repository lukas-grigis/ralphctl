import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';

/**
 * Append a wildcard pattern to `<repoRoot>/.git/info/exclude` if (and only if) the same
 * line isn't already there. Idempotent — repeated calls with the same pattern leave the
 * file with a single entry. Used by the filesystem skills adapter on first install to
 * hide harness-authored `ralphctl-*` skill folders from `git status` forever.
 *
 * Handles the three layouts git can present:
 *  - Plain repo:  `<repoRoot>/.git/info/exclude` exists (or its parent dir does).
 *  - Linked worktree: `<repoRoot>/.git` is a FILE whose contents are `gitdir: <path>`, and
 *    that gitdir carries a `commondir` pointer back to the main repo's `.git`. `info/` is a
 *    COMMON path in git, so git reads `$GIT_COMMON_DIR/info/exclude` and never the
 *    per-worktree copy — the wildcard must be written to the common dir or it has no effect.
 *  - Not a git repo / `.git` missing: there's no exclude file to write; return Ok and
 *    skip silently. The caller (skills install) wants best-effort behaviour here — a
 *    non-git working tree is a legitimate place to run ralphctl.
 *
 * Line-equality match ignores leading/trailing whitespace so a hand-edited `exclude`
 * with the same pattern but trailing spaces is detected as already-present.
 */
export const ensureGitExcludeWildcard = async (
  repoRoot: AbsolutePath,
  pattern: string
): Promise<Result<void, StorageError>> => {
  const resolvedResult = await resolveExcludePath(String(repoRoot));
  if (!resolvedResult.ok) return Result.error(resolvedResult.error);
  const resolved = resolvedResult.value;
  if (resolved === undefined) return Result.ok(undefined);

  let existing = '';
  try {
    existing = await fs.readFile(resolved, 'utf8');
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) {
      // No exclude file yet — fall through to the write path with an empty body.
    } else {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to read ${resolved}: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: resolved,
          cause,
        })
      );
    }
  }

  const trimmedPattern = pattern.trim();
  const present = existing.split('\n').some((line) => line.trim() === trimmedPattern);
  if (present) return Result.ok(undefined);

  // Preserve any existing terminating newline; append exactly one if missing.
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const next = `${existing}${separator}${trimmedPattern}\n`;
  return writeTextAtomic(resolved, next);
};

/**
 * Resolve the path of the `info/exclude` file git actually reads for a working tree. Yields
 * `Ok(undefined)` when no `.git` marker exists (the working tree isn't tracked by git) — the
 * caller treats that as a no-op rather than an error. Any other inspection failure (EACCES,
 * ELOOP, EPERM …) comes back as an error Result: the whole module is best-effort, so it must
 * never throw a raw Node errno error out of the `Result` envelope.
 */
const resolveExcludePath = async (repoRoot: string): Promise<Result<string | undefined, StorageError>> => {
  const gitMarker = join(repoRoot, '.git');
  let stat;
  try {
    stat = await fs.stat(gitMarker);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return Result.ok(undefined);
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to inspect ${gitMarker}: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: gitMarker,
        cause,
      })
    );
  }
  if (stat.isDirectory()) {
    return Result.ok(join(gitMarker, 'info', 'exclude'));
  }
  if (!stat.isFile()) return Result.ok(undefined);

  // Worktree: `.git` is a pointer file like `gitdir: /abs/path/.git/worktrees/<name>`.
  // The pointer's path may be relative to repoRoot; resolve accordingly.
  let pointer: string;
  try {
    pointer = await fs.readFile(gitMarker, 'utf8');
  } catch {
    return Result.ok(undefined);
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
  if (match === null) return Result.ok(undefined);
  const gitdir = match[1]!.trim();
  const absoluteGitdir = isAbsolute(gitdir) ? gitdir : resolve(repoRoot, gitdir);
  return Result.ok(join(await resolveCommonDir(absoluteGitdir), 'info', 'exclude'));
};

/**
 * Map a gitdir to the git dir whose `info/` git consults. For a linked worktree that is the
 * main repo's `.git`, named by the `commondir` file git writes into every worktree gitdir
 * (content is a path, absolute or relative to the gitdir). Layouts without that file —
 * submodules at `<super>/.git/modules/<name>`, any hand-rolled pointer — own their `info/`
 * directly, so the gitdir itself is the answer.
 */
const resolveCommonDir = async (gitdir: string): Promise<string> => {
  let commondir: string;
  try {
    commondir = await fs.readFile(join(gitdir, 'commondir'), 'utf8');
  } catch {
    return gitdir;
  }
  const trimmed = commondir.trim();
  return trimmed.length === 0 ? gitdir : resolve(gitdir, trimmed);
};

const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
