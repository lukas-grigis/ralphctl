import { Result } from '@src/domain/result.ts';
import { z } from 'zod';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

declare const __isoTimestamp: unique symbol;
export type IsoTimestamp = string & { readonly [__isoTimestamp]: 'IsoTimestamp' };

const schema = z.iso.datetime({ offset: true });

export const IsoTimestamp = {
  parse(input: unknown): Result<IsoTimestamp, ValidationError> {
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
  },

  now(): IsoTimestamp {
    return new Date().toISOString() as IsoTimestamp;
  },

  fromDate(d: Date): IsoTimestamp {
    return d.toISOString() as IsoTimestamp;
  },
};
