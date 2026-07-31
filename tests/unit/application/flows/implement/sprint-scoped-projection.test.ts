import { describe, expect, it } from 'vitest';

import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { projectSprintScopedFields } from '@src/application/flows/implement/sprint-scoped-projection.ts';

import { absolutePath, makeExecution, makePlannedSprint } from '@tests/fixtures/domain.ts';

const sprint = makePlannedSprint();

describe('projectSprintScopedFields', () => {
  it('carries every sprint-scoped field from ctx', () => {
    const ctx: ImplementCtx = {
      sprintId: sprint.id,
      sprint,
      execution: makeExecution(sprint.id),
      progressFile: absolutePath('/sprints/s1/progress.md'),
      setupVerifiedRepoIdsThisRun: [],
      priorLearnings: [],
    };

    const projected = projectSprintScopedFields(ctx);

    expect(projected).toStrictEqual({
      sprintId: ctx.sprintId,
      sprint: ctx.sprint,
      execution: ctx.execution,
      progressFile: ctx.progressFile,
      setupVerifiedRepoIdsThisRun: ctx.setupVerifiedRepoIdsThisRun,
      priorLearnings: ctx.priorLearnings,
    });
  });

  it('projects an unset optional field as an explicitly-present undefined key (Required<>, not omission)', () => {
    // The `Required<Pick<...>>` return type is the type-level forcing function (see merge-wave.test.ts's
    // "exhaustiveness guard" block): every sprint-scoped key must be assigned, present or not.
    const ctx: ImplementCtx = { sprintId: sprint.id };

    const projected = projectSprintScopedFields(ctx);

    expect('sprint' in projected).toBe(true);
    expect(projected.sprint).toBeUndefined();
  });

  it('never includes a non-sprint-scoped field (tasks / per-task / signal-accum classes)', () => {
    const ctx: ImplementCtx = { sprintId: sprint.id, currentTaskId: undefined, tasks: [] };

    const projected = projectSprintScopedFields(ctx);

    expect('tasks' in projected).toBe(false);
    expect('currentTaskId' in projected).toBe(false);
  });
});
