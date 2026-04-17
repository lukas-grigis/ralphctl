import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const selectMock = vi.fn<(opts: { message: string; choices: { label: string; value: string }[] }) => Promise<string>>();
const confirmMock = vi.fn<(opts: { message: string; default?: boolean }) => Promise<boolean>>();
const listSprintsMock = vi.fn<() => Promise<Sprint[]>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const deleteSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const getCurrentSprintMock = vi.fn<() => Promise<string | null>>();
const setCurrentSprintMock = vi.fn<(id: string | null) => Promise<void>>();
const listTasksMock = vi.fn<(id: string) => Promise<Tasks>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: () => ({
    select: (opts: { message: string; choices: { label: string; value: string }[] }) => selectMock(opts),
    confirm: (opts: { message: string; default?: boolean }) => confirmMock(opts),
  }),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  listSprints: () => listSprintsMock(),
  getSprint: (id: string) => getSprintMock(id),
  deleteSprint: (id: string) => deleteSprintMock(id),
}));

vi.mock('@src/integration/persistence/config.ts', () => ({
  getCurrentSprint: () => getCurrentSprintMock(),
  setCurrentSprint: (id: string | null) => setCurrentSprintMock(id),
}));

vi.mock('@src/integration/persistence/task.ts', () => ({
  listTasks: (id: string) => listTasksMock(id),
}));

import { DeleteSprintView } from './delete-sprint-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo',
    projectId: 'prj00001',
    status: 'draft',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

const routerStub: RouterApi = {
  current: { id: 'sprint-delete' },
  stack: [{ id: 'home' }, { id: 'sprint-delete' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('DeleteSprintView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an info card when no sprints exist', async () => {
    listSprintsMock.mockResolvedValue([]);

    const { lastFrame } = render(withRouter(<DeleteSprintView />));
    await flush();

    expect(lastFrame() ?? '').toContain('No sprints to delete');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('deletes selected sprint and clears current pointer if it matched', async () => {
    listSprintsMock.mockResolvedValue([sprint(), sprint({ id: 'sprint-2', name: 'Other' })]);
    selectMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    confirmMock.mockResolvedValue(true);
    getCurrentSprintMock.mockResolvedValue('sprint-1');
    deleteSprintMock.mockResolvedValue(sprint());
    setCurrentSprintMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<DeleteSprintView />));
    await flush();
    await flush();

    expect(deleteSprintMock).toHaveBeenCalledWith('sprint-1');
    expect(setCurrentSprintMock).toHaveBeenCalledWith(null);
    expect(lastFrame() ?? '').toContain('Sprint deleted');
    expect(lastFrame() ?? '').toContain('Current sprint pointer was cleared');
  });

  it('skips the selector when sprintId prop is provided', async () => {
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    confirmMock.mockResolvedValue(true);
    getCurrentSprintMock.mockResolvedValue(null);
    deleteSprintMock.mockResolvedValue(sprint());

    render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();
    await flush();

    expect(selectMock).not.toHaveBeenCalled();
    expect(deleteSprintMock).toHaveBeenCalledWith('sprint-1');
    expect(setCurrentSprintMock).not.toHaveBeenCalled();
  });

  it('cancels without deleting when user declines confirmation', async () => {
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    confirmMock.mockResolvedValue(false);

    const { lastFrame } = render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();
    await flush();

    expect(deleteSprintMock).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Deletion cancelled');
  });
});
