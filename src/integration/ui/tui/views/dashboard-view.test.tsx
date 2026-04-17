/**
 * DashboardView tests — mocks the filesystem-backed data loader and progress
 * reader so the component can render deterministically with a fixture sprint.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { DashboardData } from './dashboard-data.ts';
import type { Sprint, Task } from '@src/domain/models.ts';

const loadDashboardDataMock = vi.fn<() => Promise<DashboardData | null>>();
const getProgressMock = vi.fn<(sprintId?: string) => Promise<string>>();

vi.mock('./dashboard-data.ts', async () => {
  const actual = await vi.importActual<typeof import('./dashboard-data.ts')>('./dashboard-data.ts');
  return {
    ...actual,
    loadDashboardData: () => loadDashboardDataMock(),
  };
});

vi.mock('@src/integration/persistence/progress.ts', () => ({
  getProgress: (sprintId?: string) => getProgressMock(sprintId),
}));

import { DashboardView } from './dashboard-view.tsx';

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    name: 'Task one',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo0001',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'My Sprint',
    projectId: 'prj00001',
    status: 'active',
    createdAt: '2026-04-15T00:00:00Z',
    activatedAt: '2026-04-15T00:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('DashboardView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when there is no current sprint', async () => {
    loadDashboardDataMock.mockResolvedValue(null);
    const { lastFrame } = render(<DashboardView />);
    await flush();
    expect(lastFrame() ?? '').toContain('No current sprint');
  });

  it('renders the sprint name, status, and task rows', async () => {
    const data: DashboardData = {
      sprint: sprint({ name: 'Alpha Sprint', status: 'active' }),
      tasks: [task({ id: 'a', name: 'Do the thing', status: 'done' })],
      approvedCount: 0,
      pendingCount: 0,
      blockedCount: 0,
      plannedTicketCount: 0,
      aiProvider: 'claude',
    };
    loadDashboardDataMock.mockResolvedValue(data);
    getProgressMock.mockResolvedValue('');

    const { lastFrame } = render(<DashboardView />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha Sprint');
    expect(frame).toContain('[active]');
    expect(frame).toContain('Do the thing');
    expect(frame).toContain('Claude');
  });

  it('surfaces blocked tasks in the blockers panel', async () => {
    const data: DashboardData = {
      sprint: sprint(),
      tasks: [
        task({ id: 'a', name: 'Dep', status: 'todo' }),
        task({ id: 'b', name: 'Blocked One', status: 'todo', blockedBy: ['a'] }),
      ],
      approvedCount: 0,
      pendingCount: 0,
      blockedCount: 1,
      plannedTicketCount: 0,
      aiProvider: null,
    };
    loadDashboardDataMock.mockResolvedValue(data);
    getProgressMock.mockResolvedValue('');

    const { lastFrame } = render(<DashboardView />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Blockers');
    expect(frame).toContain('Blocked One');
  });

  it('shows "(none)" in blockers panel when no tasks are blocked', async () => {
    const data: DashboardData = {
      sprint: sprint(),
      tasks: [task({ id: 'a', name: 'Alone', status: 'todo' })],
      approvedCount: 0,
      pendingCount: 0,
      blockedCount: 0,
      plannedTicketCount: 0,
      aiProvider: null,
    };
    loadDashboardDataMock.mockResolvedValue(data);
    getProgressMock.mockResolvedValue('');

    const { lastFrame } = render(<DashboardView />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Blockers');
    expect(frame).toContain('(none)');
  });

  it('renders recent progress entries when progress.md has content', async () => {
    const data: DashboardData = {
      sprint: sprint(),
      tasks: [],
      approvedCount: 0,
      pendingCount: 0,
      blockedCount: 0,
      plannedTicketCount: 0,
      aiProvider: null,
    };
    loadDashboardDataMock.mockResolvedValue(data);
    getProgressMock.mockResolvedValue(
      '## 2026-04-15T10:00:00Z — Task Alpha\n\nDid some work on the thing.\n\n---\n\n'
    );

    const { lastFrame } = render(<DashboardView />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Recent Progress');
    expect(frame).toContain('Task Alpha');
    expect(frame).toContain('Did some work');
  });
});
