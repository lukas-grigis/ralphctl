/**
 * Pure helpers for sprint branch names.
 *
 * Sanitisation uses a single regex + a list of forbidden patterns
 * derived from `git check-ref-format`. We mirror that exactly here — the
 * planner-emitted branch suggestions and `--branch-name` flag both reach
 * `isValidBranchName` so any drift in the validation rules would change
 * which user input gets accepted.
 */

const BRANCH_NAME_RE = /^[a-zA-Z0-9/_.-]+$/;
const BRANCH_NAME_INVALID_PATTERNS: readonly RegExp[] = [
  /\.\./, // consecutive dots
  /\.$/, // trailing dot
  /\/$/, // trailing slash
  /\.lock$/, // git ref-lock suffix
  /^-/, // leading hyphen (parsed as a flag)
  /\/\//, // empty path segment
];

const MAX_BRANCH_NAME_LENGTH = 250;

/**
 * Validate a branch name is safe for git operations. Conservative subset
 * of `git check-ref-format` — keeps the surface small enough to embed in
 * an argv list without quoting hazards.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  for (const pattern of BRANCH_NAME_INVALID_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
}

/**
 * Generate the canonical sprint branch name from a sprint ID.
 *
 * The default name simply prefixes with `ralphctl/` — sprint IDs
 * (`YYYYMMDD-HHmmss-<slug>`) are already valid as branch components, so
 * no further sanitisation is needed.
 */
export function generateBranchName(sprintId: string): string {
  return `ralphctl/${sprintId}`;
}
