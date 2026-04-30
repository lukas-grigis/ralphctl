import { Result } from 'typescript-result';
import { z } from 'zod';

import { ValidationError } from './validation-error.ts';

/**
 * `IsoTimestamp` — an ISO 8601 timestamp string.
 *
 * Accepts either a `Z` suffix (`...T00:00:00Z`) or an explicit numeric
 * offset (`...+02:00`). Validation is delegated to Zod's
 * `.datetime({ offset: true })` rule.
 *
 * `now()` always emits `Date.toISOString()` output, which is `Z`-suffixed
 * and therefore always valid by construction.
 */
declare const __isoTimestamp: unique symbol;
export type IsoTimestamp = string & { readonly [__isoTimestamp]: 'IsoTimestamp' };

const schema = z.iso.datetime({ offset: true });

function validate(input: unknown): Result<IsoTimestamp, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'iso-timestamp',
        value: input,
        message: 'iso timestamp must be a string',
      })
    );
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return Result.error(
      new ValidationError({
        field: 'iso-timestamp',
        value: input,
        message: 'iso timestamp must be ISO 8601 with offset (Z or numeric)',
        hint: 'e.g. 2026-04-29T14:15:22Z or 2026-04-29T14:15:22+02:00',
      })
    );
  }
  return Result.ok(parsed.data as IsoTimestamp);
}

export const IsoTimestamp = {
  parse(input: unknown): Result<IsoTimestamp, ValidationError> {
    return validate(input);
  },
  /** Current wall-clock time, always Z-suffixed. */
  now(): IsoTimestamp {
    return new Date().toISOString() as IsoTimestamp;
  },
  /** Convert any `Date` (Z-suffixed by `toISOString()`). */
  fromDate(d: Date): IsoTimestamp {
    return d.toISOString() as IsoTimestamp;
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. read from
   * persisted JSON whose schema has already passed validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): IsoTimestamp {
    return s as IsoTimestamp;
  },
};
