import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const inputMock = vi.fn<(opts: { message: string; default?: string }) => Promise<string>>();
const confirmMock = vi.fn<(opts: { message: string; default?: boolean }) => Promise<boolean>>();
const createSprintMock = vi.fn<(name?: string) => Promise<Sprint>>();
const setCurrentSprintMock = vi.fn<(id: string | null) => Promise<void>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: () => ({
    input: (opts: { message: string; default?: string }) => inputMock(opts),
    confirm: (opts: { message: string; default?: boolean }) => confirmMock(opts),
  }),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  createSprint: (name?: string) => createSprintMock(name),
}));

vi.mock('@src/integration/persistence/config.ts', () => ({
  setCurrentSprint: (id: string | null) => setCurrentSprintMock(id),
}));

import { CreateSprintView } from './create-sprint-view.tsx';

const routerStub: RouterApi = {
  current: { id: 'sprint-create' },
  stack: [{ id: 'home' }, { id: 'sprint-create' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

function sprintFixture(overrides: Partial<Sprint> = {}): Sprint {
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('CreateSprintView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates sprint with name and sets as current when user confirms', async () => {
    inputMock.mockResolvedValue('my sprint');
    confirmMock.mockResolvedValue(true);
    createSprintMock.mockResolvedValue(sprintFixture({ name: 'my sprint' }));
    setCurrentSprintMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<CreateSprintView />));
    await flush();
    await flush();

    expect(createSprintMock).toHaveBeenCalledWith('my sprint');
    expect(setCurrentSprintMock).toHaveBeenCalledWith('sprint-1');
    expect(lastFrame() ?? '').toContain('Sprint created');
  });

  it('treats empty name input as unnamed (passes undefined)', async () => {
    inputMock.mockResolvedValue('   ');
    confirmMock.mockResolvedValue(false);
    createSprintMock.mockResolvedValue(sprintFixture());

    render(withRouter(<CreateSprintView />));
    await flush();
    await flush();

    expect(createSprintMock).toHaveBeenCalledWith(undefined);
    expect(setCurrentSprintMock).not.toHaveBeenCalled();
  });

  it('pops back to home when prompt is cancelled', async () => {
    const { PromptCancelledError } = await import('@src/business/ports/prompt.ts');
    inputMock.mockRejectedValue(new PromptCancelledError());
    const popSpy = vi.fn();
    const router: RouterApi = { ...routerStub, pop: popSpy };

    render(
      <RouterProvider value={router}>
        <CreateSprintView />
      </RouterProvider>
    );
    await flush();
    await flush();

    expect(popSpy).toHaveBeenCalled();
    expect(createSprintMock).not.toHaveBeenCalled();
  });

  it('surfaces persistence errors in an error card', async () => {
    inputMock.mockResolvedValue('x');
    confirmMock.mockResolvedValue(false);
    createSprintMock.mockRejectedValue(new Error('disk full'));

    const { lastFrame } = render(withRouter(<CreateSprintView />));
    await flush();
    await flush();

    expect(lastFrame() ?? '').toContain('Could not create sprint');
    expect(lastFrame() ?? '').toContain('disk full');
  });
});
