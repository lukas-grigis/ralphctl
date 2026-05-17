import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { type LoadSprintCtx, loadSprintLeaf } from '@src/application/flows/_shared/sprint/load.ts';

const fakeRepo = (sprint: Sprint | undefined): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (sprint && sprint.id === id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

describe('loadSprintLeaf', () => {
  it('loads the sprint and writes it onto ctx', async () => {
    const sprint = makeDraftSprint();
    const el = loadSprintLeaf<LoadSprintCtx>({ sprintRepo: fakeRepo(sprint) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.sprint).toBe(sprint);
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.elementName).toBe('load-sprint');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('surfaces NotFoundError as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const el = loadSprintLeaf<LoadSprintCtx>({ sprintRepo: fakeRepo(undefined) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(NotFoundError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('honours a custom name for chains that load multiple sprints', async () => {
    const sprint = makeDraftSprint();
    const el = loadSprintLeaf<LoadSprintCtx>({ sprintRepo: fakeRepo(sprint) }, 'reload-sprint');

    const result = await el.execute({ sprintId: sprint.id });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace[0]?.elementName).toBe('reload-sprint');
  });
});
