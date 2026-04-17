import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const resolveSprintIdMock = vi.fn<(id?: string) => Promise<string>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const exportMock = vi.fn<(sprint: Sprint, path: string) => Promise<void>>();

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getSprint: (id: string) => getSprintMock(id),
  resolveSprintId: (id?: string) => resolveSprintIdMock(id),
}));

vi.mock('@src/integration/persistence/requirements-export.ts', () => ({
  exportRequirementsToMarkdown: (sprint: Sprint, path: string) => exportMock(sprint, path),
}));

vi.mock('@src/integration/persistence/paths.ts', () => ({
  getSprintDir: (id: string) => `/tmp/${id}`,
}));

import { RequirementsExportView } from './requirements-export-view.tsx';

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
  current: { id: 'sprint-requirements-export' },
  stack: [{ id: 'home' }, { id: 'sprint-requirements-export' }],
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

describe('RequirementsExportView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warns when sprint has no tickets', async () => {
    resolveSprintIdMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(sprint({ tickets: [] }));

    const { lastFrame } = render(withRouter(<RequirementsExportView />));
    await flush();

    expect(lastFrame() ?? '').toContain('No tickets in this sprint');
    expect(exportMock).not.toHaveBeenCalled();
  });

  it('warns when no approved requirements exist', async () => {
    resolveSprintIdMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 't', title: 'x', requirementStatus: 'pending' }],
      })
    );

    const { lastFrame } = render(withRouter(<RequirementsExportView />));
    await flush();

    expect(lastFrame() ?? '').toContain('No approved requirements');
    expect(exportMock).not.toHaveBeenCalled();
  });

  it('writes requirements.md and shows the path on success', async () => {
    resolveSprintIdMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 't', title: 'x', requirementStatus: 'approved' }],
      })
    );
    exportMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<RequirementsExportView />));
    await flush();

    expect(exportMock).toHaveBeenCalledWith(expect.any(Object), '/tmp/sprint-1/requirements.md');
    expect(lastFrame() ?? '').toContain('Requirements exported');
    expect(lastFrame() ?? '').toContain('/tmp/sprint-1/requirements.md');
  });
});
