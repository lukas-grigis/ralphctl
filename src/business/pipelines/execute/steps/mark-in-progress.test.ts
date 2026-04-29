import { describe, expect, it, vi } from 'vitest';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { markInProgress } from './mark-in-progress.ts';
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

function makeTask(status: Task['status'] = 'todo'): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status,
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    evaluated: false,
  };
}

function makeSignalBus(events: HarnessEvent[]): SignalBusPort {
  return {
    emit: (e) => events.push(e),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

function makePersistence(update: PersistencePort['updateTaskStatus'], repoPath = '/repo'): PersistencePort {
  return {
    updateTaskStatus: update,
    resolveRepoPath: vi.fn(() => Promise.resolve(repoPath)),
  } as unknown as PersistencePort;
}

function makeExternal(headSha: string | null = 'abc1234'): ExternalPort {
  return { getHeadSha: vi.fn(() => headSha) } as unknown as ExternalPort;
}

describe('markInProgress step', () => {
  it('updates status, captures pre-task HEAD, and emits task-started when task is todo', async () => {
    const update = vi.fn(() => Promise.resolve({} as Task));
    const events: HarnessEvent[] = [];
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask('todo') };
    const step = markInProgress({
      persistence: makePersistence(update),
      external: makeExternal('deadbee'),
      signalBus: makeSignalBus(events),
    });

    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith('t1', 'in_progress', 's1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task-started');
    if (!result.ok) return;
    expect(result.value.preTaskHeadSha).toBe('deadbee');
  });

  it('skips the persistence update when task is already in_progress but still emits and captures HEAD', async () => {
    const update = vi.fn(() => Promise.resolve({} as Task));
    const events: HarnessEvent[] = [];
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask('in_progress') };
    const step = markInProgress({
      persistence: makePersistence(update),
      external: makeExternal('cafefee'),
      signalBus: makeSignalBus(events),
    });

    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    if (!result.ok) return;
    expect(result.value.preTaskHeadSha).toBe('cafefee');
  });

  it('records preTaskHeadSha as null when HEAD is unresolvable', async () => {
    const update = vi.fn(() => Promise.resolve({} as Task));
    const events: HarnessEvent[] = [];
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask('todo') };
    const step = markInProgress({
      persistence: makePersistence(update),
      external: makeExternal(null),
      signalBus: makeSignalBus(events),
    });

    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preTaskHeadSha).toBeNull();
  });
});
