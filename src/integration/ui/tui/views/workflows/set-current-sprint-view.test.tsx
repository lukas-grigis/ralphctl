import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const selectMock = vi.fn<(opts: { message: string; choices: { label: string; value: string }[] }) => Promise<string>>();
const listSprintsMock = vi.fn<() => Promise<Sprint[]>>();
const setCurrentSprintMock = vi.fn<(id: string | null) => Promise<void>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: () => ({
    select: (opts: { message: string; choices: { label: string; value: string }[] }) => selectMock(opts),
  }),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  listSprints: () => listSprintsMock(),
}));

vi.mock('@src/integration/persistence/config.ts', () => ({
  setCurrentSprint: (id: string | null) => setCurrentSprintMock(id),
}));

import { SetCurrentSprintView } from './set-current-sprint-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo',
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
  current: { id: 'sprint-set-current' },
  stack: [{ id: 'home' }, { id: 'sprint-set-current' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('SetCurrentSprintView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows info card when no draft/active sprints exist', async () => {
    listSprintsMock.mockResolvedValue([sprint({ status: 'closed' })]);

    const { lastFrame } = render(withRouter(<SetCurrentSprintView />));
    await flush();

    expect(lastFrame() ?? '').toContain('No draft or active sprints');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('updates config with selected sprint id', async () => {
    listSprintsMock.mockResolvedValue([sprint(), sprint({ id: 'sprint-2', name: 'Other' })]);
    selectMock.mockResolvedValue('sprint-2');
    setCurrentSprintMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<SetCurrentSprintView />));
    await flush();
    await flush();

    expect(setCurrentSprintMock).toHaveBeenCalledWith('sprint-2');
    expect(lastFrame() ?? '').toContain('Current sprint set');
    expect(lastFrame() ?? '').toContain('Other');
  });
});
