/**
 * Convert an arbitrary string into kebab-case suitable for {@link Slug}: lowercase, alnum
 * separated by single hyphens, no leading/trailing hyphen. Caller still has to validate
 * via `Slug.parse` because the result can still violate the slug regex if input is empty
 * or all-non-alphanumeric.
 *
 * Examples:
 *   "Demo Project"         → "demo-project"
 *   "  My SPRINT 1  "      → "my-sprint-1"
 *   "feat/x_y!z"           → "feat-x-y-z"
 *   "---a---b---"          → "a-b"
 */
export const toKebabCase = (input: string): string =>
  input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
