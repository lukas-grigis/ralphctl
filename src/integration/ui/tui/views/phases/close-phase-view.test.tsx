import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint, Task, Tasks } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const getSprintAdapterMock = vi.fn<(id: string) => Promise<Sprint>>();
const getTasksAdapterMock = vi.fn<(id: string) => Promise<Tasks>>();
const getSprintDirectMock = vi.fn<(id: string) => Promise<Sprint>>();
const closeSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const listTasksMock = vi.fn<(id: string) => Promise<Tasks>>();
const areAllTasksDoneMock = vi.fn<(id: string) => Promise<boolean>>();
const confirmMock = vi.fn<() => Promise<boolean>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getSharedDeps: () => ({
    persistence: {
      getSprint: (id: string) => getSprintAdapterMock(id),
      getTasks: (id: string) => getTasksAdapterMock(id),
    },
  }),
  getPrompt: () => ({
    confirm: () => confirmMock(),
  }),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getSprint: (id: string) => getSprintDirectMock(id),
  closeSprint: (id: string) => closeSprintMock(id),
}));

vi.mock('@src/integration/persistence/task.ts', () => ({
  areAllTasksDone: (id: string) => areAllTasksDoneMock(id),
  listTasks: (id: string) => listTasksMock(id),
}));

vi.mock('@src/integration/external/git.ts', () => ({
  isGhAvailable: () => false,
  branchExists: () => false,
  getDefaultBranch: () => 'main',
}));

import { ClosePhaseView } from './close-phase-view.tsx';

const routerStub: RouterApi = {
  current: { id: 'close-phase' },
  stack: [{ id: 'home' }, { id: 'close-phase' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo Sprint',
    projectId: 'prj00001',
    status: 'active',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: '2026-04-16T01:00:00Z',
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 't',
    name: 'Task',
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('ClosePhaseView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the completion summary and a single Close action when no branch is set', async () => {
    getSprintAdapterMock.mockResolvedValue(sprint({ branch: null }));
    getTasksAdapterMock.mockResolvedValue([
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'done' }),
      task({ id: 'c', status: 'todo' }),
    ]);

    const { lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Close — Demo Sprint');
    expect(frame).toContain('2 done');
    expect(frame).toContain('1 todo');
    expect(frame).toContain('no PRs will be offered');
    expect(frame).toContain('Close Sprint');
    expect(frame).not.toContain('Create PRs');
  });

  it('offers the PR-creating variant when the sprint has a branch', async () => {
    getSprintAdapterMock.mockResolvedValue(sprint({ branch: 'ralphctl/demo' }));
    getTasksAdapterMock.mockResolvedValue([task({ status: 'done' })]);

    const { lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Branch: ralphctl/demo');
    expect(frame).toContain('Close Sprint + Create PRs');
  });

  it('calls closeSprint() on Enter when all tasks are done', async () => {
    getSprintAdapterMock.mockResolvedValue(sprint({ branch: null }));
    getTasksAdapterMock.mockResolvedValue([task({ status: 'done' })]);
    areAllTasksDoneMock.mockResolvedValue(true);
    getSprintDirectMock.mockResolvedValue(sprint({ branch: null }));
    closeSprintMock.mockResolvedValue(sprint({ status: 'closed', closedAt: '2026-04-16T03:00:00Z' }));

    const { stdin, lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    stdin.write('\r'); // Enter on the default "Close Sprint" entry
    await flush();
    await flush();

    expect(closeSprintMock).toHaveBeenCalledWith('sprint-1');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sprint closed');
  });

  it('prompts for confirmation when tasks remain and aborts on reject', async () => {
    getSprintAdapterMock.mockResolvedValue(sprint({ branch: null }));
    getTasksAdapterMock.mockResolvedValue([task({ status: 'todo' })]);
    areAllTasksDoneMock.mockResolvedValue(false);
    listTasksMock.mockResolvedValue([task({ status: 'todo' })]);
    confirmMock.mockResolvedValue(false);

    const { stdin } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    stdin.write('\r');
    await flush();
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(closeSprintMock).not.toHaveBeenCalled();
  });

  it('says nothing to close when the sprint is already closed', async () => {
    getSprintAdapterMock.mockResolvedValue(
      sprint({
        status: 'closed',
        closedAt: '2026-04-16T02:00:00Z',
      })
    );
    getTasksAdapterMock.mockResolvedValue([task({ status: 'done' })]);

    const { lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('This sprint is closed. Nothing to close.');
    expect(frame).not.toContain('Close Sprint +');
  });
});
