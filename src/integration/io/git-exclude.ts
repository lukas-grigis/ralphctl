import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
 *  - Worktree:    `<repoRoot>/.git` is a FILE whose contents are `gitdir: <path>`. The
 *    real `info/exclude` lives under that resolved path.
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
  const resolved = await resolveExcludePath(String(repoRoot));
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
 * Resolve the path of the writable `info/exclude` file for a working tree. Returns
 * `undefined` when no `.git` marker exists (the working tree isn't tracked by git) —
 * the caller treats that as a no-op rather than an error.
 */
const resolveExcludePath = async (repoRoot: string): Promise<string | undefined> => {
  const gitMarker = join(repoRoot, '.git');
  let stat;
  try {
    stat = await fs.stat(gitMarker);
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return undefined;
    throw cause;
  }
  if (stat.isDirectory()) {
    return join(gitMarker, 'info', 'exclude');
  }
  if (!stat.isFile()) return undefined;

  // Worktree: `.git` is a pointer file like `gitdir: /abs/path/.git/worktrees/<name>`.
  // The pointer's path may be relative to repoRoot; resolve accordingly.
  let pointer: string;
  try {
    pointer = await fs.readFile(gitMarker, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
  if (match === null) return undefined;
  const gitdir = match[1]!.trim();
  const absoluteGitdir = isAbsolute(gitdir) ? gitdir : join(repoRoot, gitdir);
  return join(absoluteGitdir, 'info', 'exclude');
};

const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
