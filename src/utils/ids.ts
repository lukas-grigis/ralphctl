import { randomBytes } from 'node:crypto';

/**
 * Generate an 8-character UUID-like ID.
 * Used for tickets and tasks.
 */
export function generateUuid8(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Sanitize a string into a URL/filesystem-safe slug.
 * Lowercase, alphanumeric + hyphens only, max 40 characters.
 */
export function slugify(input: string, maxLength = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, ''); // Remove trailing hyphen if truncation created one
}

/**
 * Generate a sprint ID in the format: YYYYMMDD-HHmmss-<slug>
 * Lexicographically sortable by creation time.
 */
export function generateSprintId(name?: string): string {
  const now = new Date();
  // Format: YYYYMMDD-HHmmss (remove non-digits from ISO string parts)
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const slug = name ? slugify(name) : generateUuid8();

  return `${date}-${time}-${slug || generateUuid8()}`;
}
