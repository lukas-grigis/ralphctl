import { randomUUID } from 'node:crypto';
import { Result } from 'typescript-result';

import { ValidationError } from './validation-error.ts';

/**
 * `TicketId` — 8 lowercase hex chars, generated from `crypto.randomUUID()`.
 *
 * Brand is intentionally distinct from `TaskId` even though the underlying
 * format is identical. Mixing the two at a call site is almost always a bug
 * and the type system catches it.
 */
declare const __ticketId: unique symbol;
export type TicketId = string & { readonly [__ticketId]: 'TicketId' };

const UUID8_REGEX = /^[0-9a-f]{8}$/;

function validate(input: unknown): Result<TicketId, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'ticket-id',
        value: input,
        message: 'ticket id must be a string',
      })
    );
  }
  if (!UUID8_REGEX.test(input)) {
    return Result.error(
      new ValidationError({
        field: 'ticket-id',
        value: input,
        message: 'ticket id must be 8 lowercase hex characters',
        hint: 'matches /^[0-9a-f]{8}$/',
      })
    );
  }
  return Result.ok(input as TicketId);
}

export const TicketId = {
  parse(input: unknown): Result<TicketId, ValidationError> {
    return validate(input);
  },
  /** Generate a fresh ticket id from the system RNG. */
  generate(): TicketId {
    // randomUUID returns "xxxxxxxx-xxxx-..." — first 8 chars are 8 hex digits,
    // already lowercase per the spec. `.toLowerCase()` is defensive.
    return randomUUID().slice(0, 8).toLowerCase() as TicketId;
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. read from
   * persisted JSON whose schema has already passed validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): TicketId {
    return s as TicketId;
  },
};
