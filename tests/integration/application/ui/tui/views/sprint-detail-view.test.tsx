/**
 * Smoke tests for SprintDetailView's phase-aware workspace layout. Verifies the "Next phase"
 * card per status and that the ticket panel leads when draft, tasks otherwise.
 */

import { describe, expect, it } from 'vitest';
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
});
