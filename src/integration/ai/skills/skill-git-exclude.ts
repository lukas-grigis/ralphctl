/**
 * `skill-git-exclude` — manage a delimited block in
 * `<sessionDir>/.git/info/exclude` that ignores the bundled-skills tree
 * for the lifetime of an AI session phase.
 *
 * Why this exists: `BundledSkillsCopier` stages skill folders under
 * `<sessionDir>/.claude/skills/<name>/`. When the session directory IS
 * the user's repo (the common single-repo execute case), a downstream
 * `git add -A` — for example, the per-task `commit-task` leaf — would
 * stage those bundled files and bake them into the user's history.
 * Then `unlink-skills` removes them locally, leaving a dirty tree
 * (deletions of just-committed files).
 *
 * The fix is intentionally narrow: write a marked-up exclude block
 * before bundled files appear, remove it after they're gone. Only
 * affects untracked files — `.gitignore` semantics — so any genuinely
 * tracked project skill in the user's repo is unaffected.
 *
 * Behaviour:
 *  - No-op when `<sessionDir>/.git/` does not exist (refine / plan /
 *    ideate workspaces under `~/.ralphctl/data/`).
 *  - Idempotent: re-adding the block strips any stale copy first so
 *    repeated installs don't duplicate the entry.
 *  - Crash-safe: the block uses BEGIN/END markers that
 *    `removeRalphctlSkillsExclude` can find and strip, so a crash
 *    between install and uninstall leaves a recoverable artefact.
 *  - Best-effort errors: callers (the copier) treat failure as
 *    non-fatal — the user just sees the original dirty-tree behaviour
 *    rather than a chain abort.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/** BEGIN marker — must be exact-match for the strip logic to find it. */
const BEGIN_MARKER = '# >>> ralphctl-managed-skills (do not edit) >>>';
/** END marker — paired with BEGIN_MARKER. */
const END_MARKER = '# <<< ralphctl-managed-skills <<<';
/**
 * Patterns written between the markers. `.claude/skills/` is a directory
 * exclude — gitignore semantics — so it stops `git add -A` from staging
 * any bundled skill folder. Project-authored skills that are already
 * tracked in the user's repo are unaffected (gitignore patterns do not
 * untrack files).
 */
const EXCLUDE_PATTERNS: readonly string[] = ['.claude/skills/'];

/**
 * Resolve the `.git/info/` directory for `cwd`, or null when `cwd` is not
 * a git repository root. Deliberately narrow: only checks `<cwd>/.git/`
 * directly. Subdirectory launches (where the repo root is an ancestor)
 * fall through to no-op — the user keeps the pre-fix behaviour rather
 * than us walking up and accidentally writing to an unrelated git repo
 * (e.g. a `~`-rooted dotfiles repo for chezmoi users).
 *
 * Worktree pointer files (`.git` is a regular file containing
 * `gitdir: <path>`) are also skipped — uncommon in ralphctl's workflow,
 * and resolving them well requires either a git spawn or a parser we
 * don't currently need.
 */
async function gitInfoDir(cwd: AbsolutePath): Promise<string | null> {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return null;
  try {
    const s = await stat(dotGit);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }
  return join(dotGit, 'info');
}

/**
 * Append (or refresh) the ralphctl exclude block in `<cwd>/.git/info/exclude`.
 * Idempotent: if the block already exists, the old copy is stripped and
 * a fresh one is written. No-op when `<cwd>` is not a git repo root.
 */
export async function addRalphctlSkillsExclude(cwd: AbsolutePath): Promise<Result<void, StorageError>> {
  const infoDir = await gitInfoDir(cwd);
  if (infoDir === null) return Result.ok();
  const excludeFile = join(infoDir, 'exclude');
  try {
    await mkdir(infoDir, { recursive: true });
    const existing = existsSync(excludeFile) ? await readFile(excludeFile, 'utf8') : '';
    const stripped = stripMarkerBlock(existing);
    const block = `${BEGIN_MARKER}\n${EXCLUDE_PATTERNS.join('\n')}\n${END_MARKER}\n`;
    const next =
      stripped.length === 0 ? block : stripped.endsWith('\n') ? `${stripped}${block}` : `${stripped}\n${block}`;
    await writeFile(excludeFile, next, 'utf8');
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to update ${excludeFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: excludeFile,
        cause: err,
      })
    );
  }
}

/**
 * Strip the ralphctl exclude block from `<cwd>/.git/info/exclude`.
 * No-op when the file or block doesn't exist. Runs even when the copier
 * had nothing tracked at uninstall time so a stale block from a crashed
 * prior run is cleaned up the next time the user runs ralphctl.
 */
export async function removeRalphctlSkillsExclude(cwd: AbsolutePath): Promise<Result<void, StorageError>> {
  const infoDir = await gitInfoDir(cwd);
  if (infoDir === null) return Result.ok();
  const excludeFile = join(infoDir, 'exclude');
  if (!existsSync(excludeFile)) return Result.ok();
  try {
    const body = await readFile(excludeFile, 'utf8');
    const stripped = stripMarkerBlock(body);
    if (stripped === body) return Result.ok();
    await writeFile(excludeFile, stripped, 'utf8');
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to update ${excludeFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: excludeFile,
        cause: err,
      })
    );
  }
}

/**
 * Remove every BEGIN..END span from `body`. Surrounding lines (and any
 * non-managed exclude entries the user added themselves) are preserved
 * verbatim. Tolerant: an unterminated BEGIN swallows everything to EOF
 * so a crash mid-write doesn't permanently corrupt the file.
 */
function stripMarkerBlock(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line === BEGIN_MARKER) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line === END_MARKER) inside = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
