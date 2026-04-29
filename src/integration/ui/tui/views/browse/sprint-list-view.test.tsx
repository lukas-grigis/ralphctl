/**
 * SprintListView tests — exercise the canonical-map-routed list shortcuts
 * (n/f/c/r) plus j/k navigation.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Project, Sprint, Tasks } from '@src/domain/models.ts';

const listSprintsMock = vi.fn<() => Promise<Sprint[]>>();
const listProjectsMock = vi.fn<() => Promise<Project[]>>();
const getTasksMock = vi.fn<(id: string) => Promise<Tasks>>();

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  listSprints: () => listSprintsMock(),
}));
vi.mock('@src/integration/persistence/project.ts', () => ({
  listProjects: () => listProjectsMock(),
}));
vi.mock('@src/integration/persistence/task.ts', () => ({
  getTasks: (id: string) => getTasksMock(id),
}));

import { RouterProvider, type RouterApi, type ViewEntry } from '../router-context.ts';
import { SprintListView } from './sprint-list-view.tsx';

const routerMocks = {
  push: vi.fn<(entry: ViewEntry) => void>(),
  pop: vi.fn<() => void>(),
  replace: vi.fn<(entry: ViewEntry) => void>(),
  reset: vi.fn<(entry: ViewEntry) => void>(),
};

const routerStub: RouterApi = {
  current: { id: 'sprint-list' },
  stack: [{ id: 'home' }, { id: 'sprint-list' }],
  push: routerMocks.push,
  pop: routerMocks.pop,
  replace: routerMocks.replace,
  reset: routerMocks.reset,
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

function sprint(id: string, name: string): Sprint {
  return {
    id,
    name,
    projectId: 'p1',
    status: 'draft',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function project(): Project {
  return {
    id: 'p1',
    name: 'demo',
    displayName: 'Demo',
    repositories: [{ id: 'r1', name: 'app', path: '/tmp/app' }],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe('SprintListView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pressing `n` opens the create-sprint workflow', async () => {
    listSprintsMock.mockResolvedValue([sprint('s1', 'alpha')]);
    listProjectsMock.mockResolvedValue([project()]);
    getTasksMock.mockResolvedValue([] as Tasks);

    const { stdin } = render(withRouter(<SprintListView />));
    await flush();

    stdin.write('n');
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({ id: 'sprint-create' });
  });

  it('pressing `c` opens set-current sprint workflow', async () => {
    listSprintsMock.mockResolvedValue([sprint('s1', 'alpha')]);
    listProjectsMock.mockResolvedValue([project()]);
    getTasksMock.mockResolvedValue([] as Tasks);

    const { stdin } = render(withRouter(<SprintListView />));
    await flush();

    stdin.write('c');
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({ id: 'sprint-set-current' });
  });

  it('pressing `r` opens delete-sprint workflow', async () => {
    listSprintsMock.mockResolvedValue([sprint('s1', 'alpha')]);
    listProjectsMock.mockResolvedValue([project()]);
    getTasksMock.mockResolvedValue([] as Tasks);

    const { stdin } = render(withRouter(<SprintListView />));
    await flush();

    stdin.write('r');
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({ id: 'sprint-delete' });
  });

  it('vim-style j/k navigates the cursor (canonical-map alias)', async () => {
    listSprintsMock.mockResolvedValue([sprint('s1', 'alpha'), sprint('s2', 'beta')]);
    listProjectsMock.mockResolvedValue([project()]);
    getTasksMock.mockResolvedValue([] as Tasks);

    const { lastFrame, stdin } = render(withRouter(<SprintListView />));
    await flush();

    const initial = lastFrame() ?? '';
    stdin.write('j');
    await flush();
    const afterJ = lastFrame() ?? '';
    expect(afterJ).not.toBe(initial);

    stdin.write('k');
    await flush();
    const afterK = lastFrame() ?? '';
    expect(afterK).toBe(initial);
  });
});
