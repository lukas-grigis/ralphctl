import { randomUUID } from 'node:crypto';
import { Result } from 'typescript-result';

import { ValidationError } from './validation-error.ts';

/**
 * `TaskId` — 8 lowercase hex chars, generated from `crypto.randomUUID()`.
 *
 * Brand is intentionally distinct from `TicketId` even though the
 * underlying format is identical. The kept-separate-files-per-VO discipline
 * (no shared base) is part of the no-barrel rule — every brand stands on
 * its own at the file level so imports at the call site read like the
 * domain vocabulary they encode.
 */
declare const __taskId: unique symbol;
export type TaskId = string & { readonly [__taskId]: 'TaskId' };

const UUID8_REGEX = /^[0-9a-f]{8}$/;

function validate(input: unknown): Result<TaskId, ValidationError> {
  if (typeof input !== 'string') {
    return Result.error(
      new ValidationError({
        field: 'task-id',
        value: input,
        message: 'task id must be a string',
      })
    );
  }
  if (!UUID8_REGEX.test(input)) {
    return Result.error(
      new ValidationError({
        field: 'task-id',
        value: input,
        message: 'task id must be 8 lowercase hex characters',
        hint: 'matches /^[0-9a-f]{8}$/',
      })
    );
  }
  return Result.ok(input as TaskId);
}

export const TaskId = {
  parse(input: unknown): Result<TaskId, ValidationError> {
    return validate(input);
  },
  /** Generate a fresh task id from the system RNG. */
  generate(): TaskId {
    return randomUUID().slice(0, 8).toLowerCase() as TaskId;
  },
  /**
   * Internal escape hatch for already-validated strings (e.g. read from
   * persisted JSON whose schema has already passed validation).
   *
   * **Do not call from business code; persistence layer only.**
   */
  trustString(s: string): TaskId {
    return s as TaskId;
  },
};
