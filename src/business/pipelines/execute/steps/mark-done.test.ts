import { describe, expect, it, vi } from 'vitest';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { markDone } from './mark-done.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
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
    projectPath: '/repo',
    verified: true,
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

function makeSignalBus(events: HarnessEvent[]): SignalBusPort {
  return {
    emit: (e) => events.push(e),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('markDone step', () => {
  it('persists done status, emits task-finished, and logs progress', async () => {
    const update = vi.fn(() => Promise.resolve({} as Task));
    const logProgress = vi.fn(() => Promise.resolve());
    const events: HarnessEvent[] = [];
    const persistence = {
      updateTaskStatus: update,
      logProgress,
    } as unknown as PersistencePort;

    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const result = await markDone({
      persistence,
      logger: makeLogger(),
      signalBus: makeSignalBus(events),
    }).execute(ctx);

    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith('t1', 'done', 's1');
    expect(logProgress).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task-finished');
  });
});
