/**
 * ProjectListView tests — keyboard routing from the list to workflow views.
 *
 * Covers the `o` (onboard) hotkey added so users can go from the projects
 * list directly to `project onboard` with `projectName` pre-filled, without
 * having to drill into the project-show view first.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Project } from '@src/domain/models.ts';

const listProjectsMock = vi.fn<() => Promise<Project[]>>();

vi.mock('@src/integration/persistence/project.ts', () => ({
  listProjects: () => listProjectsMock(),
}));

import { RouterProvider, type RouterApi, type ViewEntry } from '../router-context.ts';
import { ProjectListView } from './project-list-view.tsx';

const routerMocks = {
  push: vi.fn<(entry: ViewEntry) => void>(),
  pop: vi.fn<() => void>(),
  replace: vi.fn<(entry: ViewEntry) => void>(),
  reset: vi.fn<(entry: ViewEntry) => void>(),
};

const routerStub: RouterApi = {
  current: { id: 'project-list' },
  stack: [{ id: 'home' }, { id: 'project-list' }],
  push: routerMocks.push,
  pop: routerMocks.pop,
  replace: routerMocks.replace,
  reset: routerMocks.reset,
};

function project(name: string, displayName = name): Project {
  return {
    id: `prj${name.padEnd(5, '0').slice(0, 5)}`,
    name,
    displayName,
    repositories: [{ id: `r${name.padEnd(7, '0').slice(0, 7)}`, name: `${name}-repo`, path: `/tmp/${name}` }],
  };
}

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe('ProjectListView', () => {
  afterEach(() => vi.clearAllMocks());

  it('pressing `o` routes to project-onboard with the highlighted project pre-filled', async () => {
    listProjectsMock.mockResolvedValue([project('alpha'), project('beta')]);

    const { stdin } = render(withRouter(<ProjectListView />));
    await flush();

    // Default cursor is the first row (alpha). Press `o`.
    stdin.write('o');
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({
      id: 'project-onboard',
      props: { projectName: 'alpha' },
    });
  });

  it('pressing `o` after moving the cursor targets the newly-highlighted row', async () => {
    listProjectsMock.mockResolvedValue([project('alpha'), project('beta')]);

    const { stdin } = render(withRouter(<ProjectListView />));
    await flush();

    // Move cursor down once (to beta), then onboard.
    stdin.write('\u001B[B'); // down arrow
    await flush();
    stdin.write('o');
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({
      id: 'project-onboard',
      props: { projectName: 'beta' },
    });
  });
});
