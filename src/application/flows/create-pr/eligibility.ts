import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

const ALLOWED_STATUSES = ['review', 'done'] as const;

/** Status whitelist guard — PRs open after work is implemented (see create-pr-leaf's doc for rationale). */
export const assertSprintEligible = (sprint: Sprint): Result<void, InvalidStateError> => {
  if (ALLOWED_STATUSES.includes(sprint.status as (typeof ALLOWED_STATUSES)[number])) return Result.ok(undefined);
  return Result.error(
    new InvalidStateError({
      entity: 'sprint',
      currentState: sprint.status,
      attemptedAction: 'create-pr',
      message: `cannot create-pr on sprint in '${sprint.status}' status — allowed: ${ALLOWED_STATUSES.join(', ')}`,
    })
  );
};
