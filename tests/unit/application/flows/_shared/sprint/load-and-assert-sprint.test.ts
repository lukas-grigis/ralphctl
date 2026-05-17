import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeActiveSprint, makeDraftSprint } from '@tests/fixtures/domain.ts';
import type { LoadSprintCtx } from '@src/application/flows/_shared/sprint/load.ts';
import type { AssertSprintStatusCtx } from '@src/application/flows/_shared/sprint/assert-status.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';

type Ctx = LoadSprintCtx & AssertSprintStatusCtx;

const fakeRepo = (sprint: Sprint | undefined): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (sprint && sprint.id === id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

describe('loadAndAssertSprintSubChain', () => {
  it('loads the sprint then asserts the status — both steps in the trace on the happy path', async () => {
    const draft = makeDraftSprint();
    const el = loadAndAssertSprintSubChain<Ctx>({ sprintRepo: fakeRepo(draft) }, ['draft']);

    const result = await el.execute({ sprintId: draft.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.sprint).toBe(draft);
      expect(result.value.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual([
        'load-sprint:completed',
        'assert-sprint-status:completed',
      ]);
    }
  });

  it('marks the assert step skipped when load-sprint fails', async () => {
    const draft = makeDraftSprint();
    const el = loadAndAssertSprintSubChain<Ctx>({ sprintRepo: fakeRepo(undefined) }, ['draft']);

    const result = await el.execute({ sprintId: draft.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(NotFoundError);
      expect(result.error.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual([
        'load-sprint:failed',
        'assert-sprint-status:skipped',
      ]);
    }
  });

  it('surfaces an InvalidStateError from the assert step when the sprint is in the wrong status', async () => {
    const active = makeActiveSprint();
    const el = loadAndAssertSprintSubChain<Ctx>({ sprintRepo: fakeRepo(active) }, ['draft']);

    const result = await el.execute({ sprintId: active.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual([
        'load-sprint:completed',
        'assert-sprint-status:failed',
      ]);
    }
  });
});
