import { describe, expect, it } from 'vitest';
import { SprintStatusError, StepError } from '@src/domain/errors.ts';
import type { Sprint, SprintStatus } from '@src/domain/models.ts';
import type { StepContext } from '@src/domain/context.ts';
import { assertSprintStatusStep } from './assert-sprint-status.ts';

interface Ctx extends StepContext {
  sprint?: Sprint;
}

function makeSprint(status: SprintStatus): Sprint {
  return {
    id: 's1',
    name: 'Sprint 1',
    projectId: 'prj00001',
    status,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

describe('assertSprintStatusStep', () => {
  it('passes when status matches single expected value', async () => {
    const step = assertSprintStatusStep<Ctx>(['draft'], 'refine');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint('draft') });
    expect(result.ok).toBe(true);
  });

  it('passes when status matches any of multiple expected values', async () => {
    const step = assertSprintStatusStep<Ctx>(['draft', 'active'], 'start');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint('active') });
    expect(result.ok).toBe(true);
  });

  it('returns SprintStatusError when status does not match', async () => {
    const step = assertSprintStatusStep<Ctx>(['draft'], 'refine');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint('active') });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(SprintStatusError);
    const err = result.error as SprintStatusError;
    expect(err.currentStatus).toBe('active');
    expect(err.operation).toBe('refine');
  });

  it('returns StepError when ctx.sprint is missing', async () => {
    const step = assertSprintStatusStep<Ctx>(['draft'], 'refine');
    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });

  it('includes all expected statuses in the error message', async () => {
    const step = assertSprintStatusStep<Ctx>(['draft', 'active'], 'foo');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint('closed') });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('draft | active');
  });
});
