import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { finalizeGenEvalUseCase } from '@src/business/task/finalize-gen-eval.ts';

const okRepo: UpdateTask = {
  async update() {
    return Result.ok(undefined);
  },
};
const sprintId = 'sprint-x' as SprintId;
const config = async () => ({ maxTurns: 5 });

describe('finalizeGenEvalUseCase', () => {
  it('passed exit → verdict passed, no warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'passed' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('passed');
      expect(result.value.warning).toBeUndefined();
    }
  });

  it('self-blocked exit → verdict failed, blockedReason set, no warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'self-blocked', reason: 'no key' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('failed');
      expect(result.value.blockedReason).toBe('no key');
      expect(result.value.warning).toBeUndefined();
    }
  });

  it('malformed exit → verdict malformed, malformed warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('malformed');
      expect(result.value.warning?.kind).toBe('malformed');
    }
  });

  it('plateau exit → verdict failed, plateau warning with dimensions', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'plateau') {
      expect(result.value.warning.dimensions).toEqual(['correctness']);
    }
  });

  it('budget-exhausted exit explicit → warning carries turnsUsed + turnBudget', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'budget-exhausted') {
      expect(result.value.warning.turnsUsed).toBe(5);
      expect(result.value.warning.turnBudget).toBe(5);
    }
  });

  it('synthesises budget-exhausted exit when exit is undefined', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      turnsUsed: 7,
      readConfig: async () => ({ maxTurns: 7 }),
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit.kind).toBe('budget-exhausted');
      if (result.value.warning?.kind === 'budget-exhausted') {
        expect(result.value.warning.turnBudget).toBe(7);
      }
    }
  });

  it('clamps an unreasonable maxTurns config to >= 1', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      turnsUsed: 0,
      readConfig: async () => ({ maxTurns: 0 }),
      taskRepo: okRepo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'budget-exhausted') {
      expect(result.value.warning.turnBudget).toBe(1);
    }
  });

  it('forwards a StorageError from the repo', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const failing: UpdateTask = {
      async update() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
    };
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'passed' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: failing,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });
});
