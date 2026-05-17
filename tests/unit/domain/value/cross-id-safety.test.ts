import { describe, expectTypeOf, it } from 'vitest';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

/**
 * Type-level tests asserting branded ids are not assignable to one another. These run as
 * `tsc` checks; the runtime block is a no-op. If any pair becomes mutually assignable, the
 * `expectTypeOf` assertion below fires at typecheck.
 */
describe('cross-id safety', () => {
  it('branded ids do not cross-mix', () => {
    expectTypeOf<ProjectId>().not.toExtend<SprintId>();
    expectTypeOf<ProjectId>().not.toExtend<RepositoryId>();
    expectTypeOf<ProjectId>().not.toExtend<TaskId>();
    expectTypeOf<ProjectId>().not.toExtend<TicketId>();

    expectTypeOf<SprintId>().not.toExtend<ProjectId>();
    expectTypeOf<SprintId>().not.toExtend<RepositoryId>();
    expectTypeOf<SprintId>().not.toExtend<TaskId>();
    expectTypeOf<SprintId>().not.toExtend<TicketId>();

    expectTypeOf<RepositoryId>().not.toExtend<ProjectId>();
    expectTypeOf<RepositoryId>().not.toExtend<SprintId>();
    expectTypeOf<RepositoryId>().not.toExtend<TaskId>();
    expectTypeOf<RepositoryId>().not.toExtend<TicketId>();

    expectTypeOf<TaskId>().not.toExtend<TicketId>();
    expectTypeOf<TicketId>().not.toExtend<TaskId>();

    // Plain string is not a branded id either.
    expectTypeOf<string>().not.toExtend<ProjectId>();
    expectTypeOf<string>().not.toExtend<TaskId>();
  });
});
