import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprint, makeExecution } from '@tests/fixtures/domain.ts';
import {
  type SaveSprintExecutionCtx,
  saveSprintExecutionLeaf,
} from '@src/application/flows/_shared/sprint/save-execution.ts';

const fakeRepo = (
  opts: { failSave?: StorageError } = {}
): { repo: SprintExecutionRepository; saved: SprintExecution[] } => {
  const saved: SprintExecution[] = [];
  const repo = {
    async save(execution: SprintExecution) {
      if (opts.failSave) return Result.error(opts.failSave);
      saved.push(execution);
      return Result.ok(undefined);
    },
  } as SprintExecutionRepository;
  return { repo, saved };
};

describe('saveSprintExecutionLeaf', () => {
  it('persists ctx.execution and returns ctx unchanged', async () => {
    const sprint = makeDraftSprint();
    const execution = makeExecution(sprint.id);
    const { repo, saved } = fakeRepo();
    const el = saveSprintExecutionLeaf<SaveSprintExecutionCtx>({ sprintExecutionRepo: repo });

    const result = await el.execute({ execution });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ execution });
      expect(result.value.trace[0]?.status).toBe('completed');
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(execution);
  });

  it('surfaces a storage error as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const execution = makeExecution(sprint.id);
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeRepo({ failSave: failure });
    const el = saveSprintExecutionLeaf<SaveSprintExecutionCtx>({ sprintExecutionRepo: repo });

    const result = await el.execute({ execution });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(failure);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('surfaces a missing-execution precondition as a failed trace entry (chain wiring error)', async () => {
    const { repo } = fakeRepo();
    const el = saveSprintExecutionLeaf<SaveSprintExecutionCtx>({ sprintExecutionRepo: repo });

    const result = await el.execute({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });
});
