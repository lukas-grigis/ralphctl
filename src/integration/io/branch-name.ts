/**
 * Pure helpers for sprint branch names.
 *
 * Sanitisation mirrors a conservative subset of `git check-ref-format`. Same surface as both
 * the generator (no surprises from the canonical `ralphctl/<sprint-id>` shape) and any future
 * `--branch-name` flag (catches typos before the spawn).
 */

const BRANCH_NAME_RE = /^[a-zA-Z0-9/_.-]+$/;
const BRANCH_NAME_INVALID_PATTERNS: readonly RegExp[] = [
  /\.\./, // consecutive dots
  /\.$/, // trailing dot
  /\/$/, // trailing slash
  /\.lock$/, // git ref-lock suffix
  /^-/, // leading hyphen — would parse as a CLI flag
  /\/\//, // empty path segment
];

const MAX_BRANCH_NAME_LENGTH = 250;

export const isValidBranchName = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  for (const pattern of BRANCH_NAME_INVALID_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
};

/**
 * Canonical sprint branch name. Sprint ids are UUID-shaped, so the prefix is the only
 * decoration needed — the result is always a valid git ref name.
 */
export const generateBranchName = (sprintId: string): string => `ralphctl/${sprintId}`;
