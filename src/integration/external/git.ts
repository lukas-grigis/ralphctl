import { spawnSync } from 'node:child_process';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';
import { StorageError } from '@src/domain/errors.ts';

/**
 * Git utility functions for branch management.
 *
 * All functions validate their cwd via assertSafeCwd() before running
 * any git commands — no raw user input reaches the shell.
 */

// Branch name pattern: alphanumeric, hyphens, underscores, dots, and slashes.
// Rejects control chars, spaces, ~, ^, :, ?, *, [, \, consecutive dots, trailing dots/slashes/locks.
const BRANCH_NAME_RE = /^[a-zA-Z0-9/_.-]+$/;
const BRANCH_NAME_INVALID_PATTERNS = [/\.\./, /\.$/, /\/$/, /\.lock$/, /^-/, /\/\//];

/**
 * Validate a branch name is safe for git operations.
 * Based on `git check-ref-format` rules.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 250) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  for (const pattern of BRANCH_NAME_INVALID_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
}

/**
 * Get the current branch name.
 * Returns 'HEAD' if in detached HEAD state.
 */
export function getCurrentBranch(cwd: string): string {
  assertSafeCwd(cwd);
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to get current branch in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Check if a local branch exists.
 */
export function branchExists(cwd: string, name: string): boolean {
  assertSafeCwd(cwd);
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  const result = spawnSync('git', ['show-ref', '--verify', `refs/heads/${name}`], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/**
 * Create a new branch and check it out, or check out if it already exists.
 * Idempotent — safe to call on resume/crash recovery.
 */
export function createAndCheckoutBranch(cwd: string, name: string): void {
  assertSafeCwd(cwd);
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }

  const current = getCurrentBranch(cwd);
  if (current === name) {
    return; // Already on the requested branch
  }

  if (branchExists(cwd, name)) {
    // Branch exists — just check it out
    const result = spawnSync('git', ['checkout', name], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`Failed to checkout branch '${name}' in ${cwd}: ${result.stderr.trim()}`);
    }
  } else {
    // Create and checkout new branch
    const result = spawnSync('git', ['checkout', '-b', name], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`Failed to create branch '${name}' in ${cwd}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * Verify that the repo is on the expected branch.
 * Returns true if current branch matches expected.
 */
export function verifyCurrentBranch(cwd: string, expected: string): boolean {
  const current = getCurrentBranch(cwd);
  return current === expected;
}

/**
 * Detect the default branch (main or master) from remote origin.
 * Falls back to checking local branches if no remote is configured.
 * Throws on unexpected git errors (permissions, corrupted repo, etc.).
 */
export function getDefaultBranch(cwd: string): string {
  assertSafeCwd(cwd);
  const result = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    // refs/remotes/origin/main → main
    const ref = result.stdout.trim();
    const parts = ref.split('/');
    return parts[parts.length - 1] ?? 'main';
  }

  // "not a symbolic ref" — remote ref not configured, safe to fall through
  const stderr = result.stderr.trim();
  if (stderr.includes('is not a symbolic ref') || stderr.includes('No such ref')) {
    if (branchExists(cwd, 'main')) return 'main';
    if (branchExists(cwd, 'master')) return 'master';
    return 'main';
  }

  // Unexpected error — don't swallow it
  throw new Error(`Failed to detect default branch in ${cwd}: ${stderr}`);
}

/**
 * Get the SHA of HEAD for the given repo. Returns null if the repo is empty
 * or not a git repository — never throws.
 */
export function getHeadSha(cwd: string): string | null {
  try {
    assertSafeCwd(cwd);
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * List files changed in the working tree since a baseline commit.
 *
 * Combines:
 *   - `git diff --name-only <baseline>..HEAD` — committed changes
 *   - `git status --porcelain` — uncommitted (staged + unstaged + untracked)
 *
 * Returns an empty array on any git failure or when the baseline is missing
 * — callers use the empty result as the "no changes" signal. Never throws.
 *
 * Validates the baseline against a hex-SHA pattern before invoking git so a
 * malformed value can't be wedged into the argument vector. Hex matching is
 * permissive (any length 7–64) so this stays compatible with abbreviated
 * SHAs returned by `getHeadSha()`.
 */
export function getChangedFilesSince(cwd: string, baselineSha: string): string[] {
  if (!/^[0-9a-f]{7,64}$/i.test(baselineSha)) return [];
  try {
    assertSafeCwd(cwd);
  } catch {
    return [];
  }
  const diff = spawnSync('git', ['diff', '--name-only', `${baselineSha}..HEAD`], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const files = new Set<string>();
  if (diff.status === 0) {
    for (const line of diff.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  if (status.status === 0) {
    for (const line of status.stdout.split('\n')) {
      // porcelain v1: `XY <path>` (or `XY <orig> -> <path>` for renames).
      // We only care that *something* changed — pull the trailing path.
      const trimmed = line.replace(/^.{2}\s*/, '').trim();
      if (!trimmed) continue;
      const arrow = trimmed.split(' -> ');
      const path = arrow.length > 1 ? arrow[arrow.length - 1] : arrow[0];
      if (path) files.add(path);
    }
  }
  return [...files];
}

/**
 * Check if the working directory has uncommitted changes (staged or unstaged).
 */
export function hasUncommittedChanges(cwd: string): boolean {
  assertSafeCwd(cwd);
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to check git status in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().length > 0;
}

/**
 * Hard-reset tracked files to HEAD and remove untracked files and directories.
 *
 * Runs `git reset --hard HEAD` then `git clean -fd`. Throws `StorageError`
 * with the underlying stderr if either step fails (e.g. read-only working
 * tree). Destructive — callers must only invoke this on explicit user consent.
 */
export function hardResetWorkingTree(cwd: string): void {
  assertSafeCwd(cwd);
  const reset = spawnSync('git', ['reset', '--hard', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (reset.status !== 0) {
    throw new StorageError(`Failed to reset working tree in ${cwd}: ${reset.stderr.trim() || reset.stdout.trim()}`);
  }
  const clean = spawnSync('git', ['clean', '-fd'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (clean.status !== 0) {
    throw new StorageError(`Failed to clean working tree in ${cwd}: ${clean.stderr.trim() || clean.stdout.trim()}`);
  }
}

/**
 * Stage all changes in the working tree and commit with the given message.
 * Throws on any git failure (stage or commit), with the git stderr
 * preserved in the error message.
 */
export function autoCommit(cwd: string, message: string): void {
  assertSafeCwd(cwd);
  const add = spawnSync('git', ['add', '-A'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (add.status !== 0) {
    throw new Error(`Failed to stage changes in ${cwd}: ${add.stderr.trim()}`);
  }
  const commit = spawnSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (commit.status !== 0) {
    throw new Error(`Failed to commit in ${cwd}: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
}

/**
 * Generate a branch name from a sprint ID.
 * Format: `ralphctl/<sprint-id>`
 */
export function generateBranchName(sprintId: string): string {
  return `ralphctl/${sprintId}`;
}

/**
 * Check if the `gh` CLI is available in PATH.
 */
export function isGhAvailable(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/**
 * Check if the `glab` CLI is available in PATH.
 */
export function isGlabAvailable(): boolean {
  const result = spawnSync('glab', ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}
