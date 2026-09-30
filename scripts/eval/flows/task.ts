import { Result } from '@src/domain/result.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { TaskSpec } from '../fixture-schema.ts';

/**
 * Build the `InProgressTask` a role prompt is rendered from. Same path the harness takes: the spec
 * was validated by `TaskImportSpecSchema` (the schema planner output must pass), `createTask`
 * enforces the domain invariants, and `startNextAttempt` is the domain transition that moves a
 * `todo` task to `in_progress`.
 */
export const buildInProgressTask = (spec: TaskSpec): Result<InProgressTask, DomainError> => {
  const created = createTask({
    name: spec.name,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    steps: spec.steps,
    verificationCriteria: spec.verificationCriteria.map((c) => ({
      id: c.id,
      assertion: c.assertion,
      check: c.check,
      ...(c.command !== undefined ? { command: c.command } : {}),
    })),
    order: 1,
    ticketId: TicketId.generate(),
    repositoryId: RepositoryId.generate(),
    ...(spec.extraDimensions !== undefined ? { extraDimensions: spec.extraDimensions } : {}),
  });
  if (!created.ok) return Result.error(created.error);
  const started = startNextAttempt(created.value, IsoTimestamp.now());
  return started.ok ? Result.ok(started.value) : Result.error(started.error);
};
