import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { Result } from '@src/domain/result.ts';
import { LIVE_TASKS_DEBOUNCE_MS, useAppStateSnapshot } from '@src/application/ui/tui/runtime/use-app-state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { makeDraftSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const Probe = ({ liveTasks }: { readonly liveTasks: boolean }): React.JSX.Element => {
  const { state } = useAppStateSnapshot({ liveTasks });
  return <Text>{state.kind === 'ok' ? `tasks:${String(state.value.tasks.length)}` : state.kind}</Text>;
};

const setup = (liveTasks: boolean) => {
  const project = makeProject();
  const sprint = makeDraftSprint();
  const task = makeTodoTask();
  const taskLoads = { count: 0 };
  const cap = createCapturingBus();
  const deps = {
    eventBus: cap.bus,
    projectRepo: {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([sprint]);
      },
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        taskLoads.count += 1;
        return Result.ok([task]);
      },
    } as unknown as TaskRepository,
  } as unknown as AppDeps;
  const rendered = renderView(<Probe liveTasks={liveTasks} />, {
    deps,
    initial: { id: 'home' },
    selection: { projectId: project.id, sprintId: sprint.id },
  });
  return { ...rendered, bus: cap.bus, task, taskLoads };
};

const blocked = (taskId: string) =>
  ({
    type: 'task-blocked',
    taskId,
    taskName: 'x',
    blockKind: 'own',
    reason: 'verify failed',
    at: IsoTimestamp.now(),
  }) as const;

describe('useAppStateSnapshot liveTasks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads once, debounced, when a task of the loaded sprint is blocked', async () => {
    const { result, bus, task, taskLoads } = setup(true);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('tasks:1'));
    const before = taskLoads.count;

    vi.useFakeTimers();
    bus.publish(blocked(task.id));
    bus.publish(blocked(task.id));
    await vi.advanceTimersByTimeAsync(LIVE_TASKS_DEBOUNCE_MS - 50);
    expect(taskLoads.count).toBe(before);
    await vi.advanceTimersByTimeAsync(100);
    // The debounced reload has fired; let React commit it on real timers.
    vi.useRealTimers();
    await waitForPredicate(() => taskLoads.count > before);
    await new Promise((r) => setTimeout(r, 100));
    expect(taskLoads.count).toBe(before + 1);
  });

  it('ignores events for tasks of another sprint', async () => {
    const { result, bus, taskLoads } = setup(true);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('tasks:1'));
    const before = taskLoads.count;

    vi.useFakeTimers();
    bus.publish(blocked('some-other-sprints-task'));
    await vi.advanceTimersByTimeAsync(LIVE_TASKS_DEBOUNCE_MS * 2);
    expect(taskLoads.count).toBe(before);
  });

  it('does not subscribe unless asked', async () => {
    const { result, bus, task, taskLoads } = setup(false);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('tasks:1'));
    const before = taskLoads.count;

    vi.useFakeTimers();
    bus.publish(blocked(task.id));
    await vi.advanceTimersByTimeAsync(LIVE_TASKS_DEBOUNCE_MS * 2);
    expect(taskLoads.count).toBe(before);
  });
});
