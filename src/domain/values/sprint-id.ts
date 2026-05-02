import { Result } from 'typescript-result';

import type { Slug } from './slug.ts';
import { ValidationError } from './validation-error.ts';

/**
 * `SprintId` — `YYYYMMDD-HHmmss-<slug>` (lexicographically sortable by
 * creation time).
 *
 * The trailing slug part follows {@link Slug}'s rules (lowercase alnum +
 * hyphens, 1..64 chars, no leading/trailing hyphen). Examples:
 *   `20260429-141522-my-sprint`
 *   `20240101-000000-x`
 *
 * Note: This regex permits any 8 digits as the date and any 6 digits as the
 * time — it does **not** validate that the date/time is real (e.g. month
 * 13 or day 32 will pass). The lexicographic-sort property is what callers
 * rely on; calendar correctness is enforced at sprint-creation time by the
 * `SprintId.create(date, slug)` helper, which formats from a real `Date`.
 */
declare const __sprintId: unique symbol;
export type SprintId = string & { readonly [__sprintId]: 'SprintId' };

// Date-time prefix (8+6 digits) followed by the same body shape Slug accepts.
const SPRINT_ID_REGEX = /^\d{8}-\d{6}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validate(input: unknown): Result<SprintId, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'sprint-id',
        value: input,
        message: 'sprint id must be a string',
      })
    );
  }
  if (!SPRINT_ID_REGEX.test(input)) {
    return Result.error(
      new ValidationError({
        field: 'sprint-id',
        value: input,
        message: 'sprint id must match YYYYMMDD-HHmmss-<slug>',
        hint: 'e.g. 20260429-141522-my-sprint',
      })
    );
  }
  return Result.ok(input as SprintId);
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0');
}

function formatDate(date: Date): string {
  // UTC keeps the id deterministic across machines & timezones.
  const y = pad(date.getUTCFullYear(), 4);
  const m = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  const hh = pad(date.getUTCHours(), 2);
  const mm = pad(date.getUTCMinutes(), 2);
  const ss = pad(date.getUTCSeconds(), 2);
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

export const SprintId = {
  parse(input: unknown): Result<SprintId, ValidationError> {
    return validate(input);
  },
  /**
   * Build a sprint id from a real `Date` and an already-validated `Slug`.
   * No additional validation needed — the slug is a brand, the date format
   * is mechanical.
   */
  create(date: Date, slug: Slug): SprintId {
    return `${formatDate(date)}-${slug}` as SprintId;
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. read from
   * persisted JSON whose schema has already passed validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): SprintId {
    return s as SprintId;
  },
};
