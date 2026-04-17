import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint, Task, Tasks } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const getTasksMock = vi.fn<(id: string) => Promise<Tasks>>();
const closeHandlerMock = vi.fn<() => Promise<void>>();
const closeWithPrHandlerMock = vi.fn<() => Promise<void>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getSharedDeps: () => ({
    persistence: {
      getSprint: (id: string) => getSprintMock(id),
      getTasks: (id: string) => getTasksMock(id),
    },
  }),
}));

vi.mock('@src/integration/ui/tui/views/command-map.ts', () => ({
  commandMap: {
    sprint: {
      close: () => closeHandlerMock(),
      'close --create-pr': () => closeWithPrHandlerMock(),
    },
  },
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
    projectPath: '/tmp/repo',
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
    getSprintMock.mockResolvedValue(sprint({ branch: null }));
    getTasksMock.mockResolvedValue([
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
    getSprintMock.mockResolvedValue(sprint({ branch: 'ralphctl/demo' }));
    getTasksMock.mockResolvedValue([task({ status: 'done' })]);

    const { lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Branch: ralphctl/demo');
    expect(frame).toContain('Close Sprint + Create PRs');
  });

  it('dispatches the plain close handler on Enter', async () => {
    getSprintMock.mockResolvedValue(sprint({ branch: null }));
    getTasksMock.mockResolvedValue([task({ status: 'done' })]);
    closeHandlerMock.mockResolvedValue();

    const { stdin } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    stdin.write('\r'); // Enter on the default "Close Sprint" entry
    await flush();
    await flush();

    expect(closeHandlerMock).toHaveBeenCalledTimes(1);
    expect(closeWithPrHandlerMock).not.toHaveBeenCalled();
  });

  it('says nothing to close when the sprint is already closed', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        status: 'closed',
        closedAt: '2026-04-16T02:00:00Z',
      })
    );
    getTasksMock.mockResolvedValue([task({ status: 'done' })]);

    const { lastFrame } = render(withRouter(<ClosePhaseView sprintId="sprint-1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('This sprint is closed. Nothing to close.');
    expect(frame).not.toContain('Close Sprint +');
  });
});
