import { describe, expect, it, vi } from 'vitest';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import { storeVerification } from './store-verification.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeTask(): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    evaluated: false,
  };
}

function makeSpinner(): SpinnerHandle {
  return { succeed: () => undefined, fail: () => undefined, stop: () => undefined };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

describe('storeVerification step', () => {
  it('persists verification when executionResult.verified is true', async () => {
    const updateTask = vi.fn(() => Promise.resolve());
    const ctx: PerTaskContext = {
      sprintId: 's1',
      sprint: makeSprint(),
      task: makeTask(),
      executionResult: {
        taskId: 't1',
        success: true,
        output: '',
        verified: true,
        verificationOutput: 'all good',
      },
    };

    const result = await storeVerification({
      persistence: { updateTask } as unknown as PersistencePort,
      logger: makeLogger(),
    }).execute(ctx);

    expect(result.ok).toBe(true);
    expect(updateTask).toHaveBeenCalledWith('t1', { verified: true, verificationOutput: 'all good' }, 's1');
  });

  it('no-ops when executionResult.verified is false or missing', async () => {
    const updateTask = vi.fn(() => Promise.resolve());
    const ctx: PerTaskContext = {
      sprintId: 's1',
      sprint: makeSprint(),
      task: makeTask(),
      executionResult: { taskId: 't1', success: true, output: '', verified: false },
    };

    const result = await storeVerification({
      persistence: { updateTask } as unknown as PersistencePort,
      logger: makeLogger(),
    }).execute(ctx);

    expect(result.ok).toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
