/**
 * Smoke tests for SprintDetailView's phase-aware workspace layout. Verifies the "Next phase"
 * card per status and that the ticket panel leads when draft, tasks otherwise.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const makeSprint = (overrides: Partial<Sprint>): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj-fixture' as never,
    status: 'draft',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

const initial = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

describe('SprintDetailView — phase workspace', () => {
  it('draft sprint with no tickets suggests "Add tickets"', async () => {
    const sprint = makeSprint({ status: 'draft', tickets: [] });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Next phase');
    expect(frame).toContain('Add tickets');
    result.unmount();
  });

  it('draft sprint with pending tickets suggests "Refine"', async () => {
    const sprint = makeSprint({
      status: 'draft',
      tickets: [
        { id: 't1' as never, title: 'first', status: 'pending' } as never,
        { id: 't2' as never, title: 'second', status: 'pending' } as never,
      ],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await tick(40);
    expect(result.lastFrame() ?? '').toContain('Refine 2 pending ticket(s)');
    result.unmount();
  });

  it('planned sprint with todo tasks suggests "Implement"; tickets always lead, tasks follow', async () => {
    const sprint = makeSprint({
      status: 'planned',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const tasks: readonly Task[] = [
      {
        id: 'task-1' as never,
        name: 'do thing',
        status: 'todo',
        dependsOn: [],
        attempts: [],
        ticketId: 't1' as never,
        repositoryId: 'r1' as never,
      } as never,
      {
        id: 'task-2' as never,
        name: 'do other thing',
        status: 'todo',
        dependsOn: [],
        attempts: [],
        ticketId: 't1' as never,
        repositoryId: 'r1' as never,
      } as never,
    ];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Implement 2 pending task(s)');
    const tasksHeader = frame.indexOf('▣ Tasks');
    const ticketsHeader = frame.indexOf('▣ Tickets');
    expect(tasksHeader).toBeGreaterThan(-1);
    expect(ticketsHeader).toBeGreaterThan(-1);
    // Tickets always come first now — the old planned-sprint flip was confusing for users.
    expect(ticketsHeader).toBeLessThan(tasksHeader);
    result.unmount();
  });

  it('review sprint suggests opening a pull request', async () => {
    const sprint = makeSprint({
      status: 'review',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await tick(40);
    expect(result.lastFrame() ?? '').toContain('Open a pull request');
    result.unmount();
  });

  it('pressing u on a blocked task flips it to todo and surfaces "✓ unblocked"', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const blockedTask: Task = {
      id: 'task-blocked' as never,
      name: 'wedged',
      status: 'blocked',
      blockedReason: 'mvn agent attach failed',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const updateCalls: Task[] = [];
    let storedStatus: 'blocked' | 'todo' = 'blocked';
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok(
            storedStatus === 'todo'
              ? [{ ...(blockedTask as object), status: 'todo' } as unknown as Task]
              : [blockedTask]
          );
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          storedStatus = task.status === 'todo' ? 'todo' : storedStatus;
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await tick(40);
    // Cursor starts at idx 0 (the ticket). Press 'j' once to land on the (one) task below.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('u');
    // Give the async use case + reload a chance to settle.
    await tick(80);
    const frame = result.lastFrame() ?? '';
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.status).toBe('todo');
    expect(frame).toContain('✓ unblocked');
    expect(frame).toContain('wedged');
    result.unmount();
  });

  it("pressing 'e' on a focused ticket (draft sprint) opens an edit-field picker, then renames the ticket", async () => {
    const ticket = makePendingTicket({ title: 'Typo iin Title' });
    const sprint = makeDraftSprint({ tickets: [] as never });
    // Splice the ticket directly so the test fixture stays simple — makeDraftSprint defaults
    // to no tickets, and addTicket would require the sprint variant.
    const sprintWithTicket = { ...sprint, tickets: [ticket] } as unknown as Sprint;
    const save = vi.fn(async (s: Sprint) => Result.ok<Sprint>(s));
    const repo = {
      async findById() {
        return Result.ok(sprintWithTicket);
      },
      save,
    } as unknown as SprintRepository;
    const deps = {
      sprintRepo: repo,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;
    const queue = createPromptQueue();
    const initialWithId = { id: 'sprint-detail', props: { sprintId: sprintWithTicket.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId, queue });
    await tick(40);
    // Cursor starts on the ticket. Press 'e' → opens the field-picker choice.
    result.stdin.write('e');
    await tick(40);
    expect(queue.head?.kind).toBe('choice');
    // Pick "title" (the first option for a pending ticket).
    queue.resolveHead('title');
    await tick(40);
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('Typo iin Title');
    }
    queue.resolveHead('Typo in Title');
    await tick(40);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.tickets?.[0]?.title).toBe('Typo in Title');
    result.unmount();
  });

  it('u is a no-op when the focused card is a todo task (no use-case invocation)', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const todoTask: Task = {
      id: 'task-todo' as never,
      name: 'fine',
      status: 'todo',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const updateCalls: Task[] = [];
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([todoTask]);
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await tick(40);
    result.stdin.write('j');
    await tick(20);
    result.stdin.write('u');
    await tick(40);
    expect(updateCalls).toHaveLength(0);
    result.unmount();
  });
});
