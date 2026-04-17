import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const confirmMock = vi.fn<(opts: { message: string; default?: boolean }) => Promise<boolean>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const saveSprintMock = vi.fn<(s: Sprint) => Promise<void>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: () => ({
    confirm: (opts: { message: string; default?: boolean }) => confirmMock(opts),
  }),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getSprint: (id: string) => getSprintMock(id),
  saveSprint: (s: Sprint) => saveSprintMock(s),
}));

import { ReactivateSprintView } from './reactivate-sprint-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    name: 'Demo',
    projectId: 'p1',
    status: 'closed',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: '2026-04-16T01:00:00Z',
    closedAt: '2026-04-17T00:00:00Z',
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

const router: RouterApi = {
  current: { id: 'sprint-reactivate' },
  stack: [{ id: 'home' }, { id: 'sprint-reactivate' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={router}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

describe('ReactivateSprintView', () => {
  afterEach(() => vi.clearAllMocks());

  it('reactivates a closed sprint after confirmation', async () => {
    getSprintMock.mockResolvedValue(sprint());
    confirmMock.mockResolvedValue(true);
    saveSprintMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<ReactivateSprintView sprintId="s1" />));
    await flush();
    await flush();

    expect(saveSprintMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', closedAt: null }));
    expect(lastFrame() ?? '').toContain('Sprint reactivated');
  });

  it('blocks reactivation when sprint is not closed', async () => {
    getSprintMock.mockResolvedValue(sprint({ status: 'active', closedAt: null }));

    const { lastFrame } = render(withRouter(<ReactivateSprintView sprintId="s1" />));
    await flush();
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(saveSprintMock).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Sprint is not closed');
  });

  it('cancels when user declines confirm', async () => {
    getSprintMock.mockResolvedValue(sprint());
    confirmMock.mockResolvedValue(false);

    const { lastFrame } = render(withRouter(<ReactivateSprintView sprintId="s1" />));
    await flush();
    await flush();

    expect(saveSprintMock).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Reactivation cancelled');
  });
});
