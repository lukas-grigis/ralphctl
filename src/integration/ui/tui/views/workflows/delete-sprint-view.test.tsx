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

vi.mock('@src/integration/bootstrap.ts', () => ({
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

  it('fires exactly one confirm (citing ticket + task counts) and deletes the sprint', async () => {
    listSprintsMock.mockResolvedValue([sprint(), sprint({ id: 'sprint-2', name: 'Other' })]);
    selectMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [
          {
            id: 't1',
            title: 'one',
            projectName: 'demo',
            requirementStatus: 'pending',
          } as unknown as Sprint['tickets'][number],
          {
            id: 't2',
            title: 'two',
            projectName: 'demo',
            requirementStatus: 'pending',
          } as unknown as Sprint['tickets'][number],
        ],
      })
    );
    listTasksMock.mockResolvedValue([
      { id: 'k1' } as unknown as Tasks[number],
      { id: 'k2' } as unknown as Tasks[number],
      { id: 'k3' } as unknown as Tasks[number],
    ]);
    confirmMock.mockResolvedValue(true);
    getCurrentSprintMock.mockResolvedValue('sprint-1');
    deleteSprintMock.mockResolvedValue(sprint());
    setCurrentSprintMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<DeleteSprintView />));
    await flush();
    await flush();

    // Exactly one confirm — the old two-step chain is gone.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const [call] = confirmMock.mock.calls;
    expect(call?.[0].message).toContain('2 tickets');
    expect(call?.[0].message).toContain('3 tasks');
    expect(call?.[0].default).toBe(false);
    expect(deleteSprintMock).toHaveBeenCalledWith('sprint-1');
    expect(setCurrentSprintMock).toHaveBeenCalledWith(null);
    expect(lastFrame() ?? '').toContain('Sprint "Demo" deleted');
  });

  it('does not clear the current-sprint pointer when a non-current sprint is deleted', async () => {
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    confirmMock.mockResolvedValue(true);
    getCurrentSprintMock.mockResolvedValue(null);
    deleteSprintMock.mockResolvedValue(sprint());

    render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();
    await flush();

    expect(selectMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deleteSprintMock).toHaveBeenCalledWith('sprint-1');
    expect(setCurrentSprintMock).not.toHaveBeenCalled();
  });

  it('cancels without deleting when user declines the single confirmation', async () => {
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    confirmMock.mockResolvedValue(false);

    const { lastFrame } = render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deleteSprintMock).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Removal cancelled');
  });

  it('blocks deletion of an active sprint before any confirm fires', async () => {
    getSprintMock.mockResolvedValue(sprint({ status: 'active', name: 'Live One' }));

    const { lastFrame } = render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(deleteSprintMock).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Cannot delete an active sprint');
    expect(frame).toContain('Live One');
  });

  it('uses singular forms in the confirm message when there is exactly one ticket and one task', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [
          {
            id: 't1',
            title: 'only',
            projectName: 'demo',
            requirementStatus: 'pending',
          } as unknown as Sprint['tickets'][number],
        ],
      })
    );
    listTasksMock.mockResolvedValue([{ id: 'k1' } as unknown as Tasks[number]]);
    confirmMock.mockResolvedValue(false);

    render(withRouter(<DeleteSprintView sprintId="sprint-1" />));
    await flush();
    await flush();

    const [singularCall] = confirmMock.mock.calls;
    expect(singularCall?.[0].message).toMatch(/1 ticket[^s]/);
    expect(singularCall?.[0].message).toMatch(/1 task[^s]/);
  });
});
