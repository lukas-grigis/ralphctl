import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeDraftSprint, makeExecution } from '@tests/fixtures/domain.ts';
import {
  type LoadSprintExecutionCtx,
  loadSprintExecutionLeaf,
} from '@src/application/flows/_shared/sprint/load-execution.ts';

const fakeRepo = (execution: SprintExecution | undefined): SprintExecutionRepository =>
  ({
    async findById(id: SprintId) {
      if (execution && execution.sprintId === id) return Result.ok(execution);
      return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
    },
  }) as SprintExecutionRepository;

describe('loadSprintExecutionLeaf', () => {
  it('loads the execution and writes it onto ctx', async () => {
    const sprint = makeDraftSprint();
    const execution = makeExecution(sprint.id);
    const el = loadSprintExecutionLeaf<LoadSprintExecutionCtx>({ sprintExecutionRepo: fakeRepo(execution) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.execution).toBe(execution);
      expect(result.value.trace[0]?.elementName).toBe('load-sprint-execution');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('surfaces NotFoundError as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const el = loadSprintExecutionLeaf<LoadSprintExecutionCtx>({ sprintExecutionRepo: fakeRepo(undefined) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(NotFoundError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('honours a custom name', async () => {
    const sprint = makeDraftSprint();
    const execution = makeExecution(sprint.id);
    const el = loadSprintExecutionLeaf<LoadSprintExecutionCtx>(
      { sprintExecutionRepo: fakeRepo(execution) },
      'reload-execution'
    );

    const result = await el.execute({ sprintId: sprint.id });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace[0]?.elementName).toBe('reload-execution');
  });
});
