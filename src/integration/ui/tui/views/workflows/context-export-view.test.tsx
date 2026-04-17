import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const resolveSprintIdMock = vi.fn<(id?: string) => Promise<string>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const listTasksMock = vi.fn<(id: string) => Promise<Tasks>>();
const getProjectMock = vi.fn<(name: string) => Promise<unknown>>();
const writeFileMock = vi.fn<(path: string, contents: string, encoding?: string) => Promise<void>>();

vi.mock('node:fs/promises', () => ({
  writeFile: (path: string, contents: string, encoding?: string) => writeFileMock(path, contents, encoding),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getSprint: (id: string) => getSprintMock(id),
  resolveSprintId: (id?: string) => resolveSprintIdMock(id),
}));

vi.mock('@src/integration/persistence/task.ts', () => ({
  listTasks: (id: string) => listTasksMock(id),
}));

vi.mock('@src/integration/persistence/project.ts', () => ({
  getProject: (name: string) => getProjectMock(name),
}));

vi.mock('@src/integration/persistence/paths.ts', () => ({
  getSprintDir: (id: string) => `/tmp/${id}`,
}));

vi.mock('@src/integration/persistence/storage.ts', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

import { ContextExportView } from './context-export-view.tsx';

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
  current: { id: 'sprint-context-export' },
  stack: [{ id: 'home' }, { id: 'sprint-context-export' }],
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

describe('ContextExportView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes context.md and shows the path on success', async () => {
    resolveSprintIdMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    writeFileMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<ContextExportView />));
    await flush();

    expect(writeFileMock).toHaveBeenCalled();
    const [path, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(path).toBe('/tmp/sprint-1/context.md');
    expect(String(contents)).toContain('# Sprint: Demo');
    expect(lastFrame() ?? '').toContain('Context exported');
  });

  it('surfaces an error card when writing fails', async () => {
    resolveSprintIdMock.mockResolvedValue('sprint-1');
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    writeFileMock.mockRejectedValue(new Error('EACCES'));

    const { lastFrame } = render(withRouter(<ContextExportView />));
    await flush();

    expect(lastFrame() ?? '').toContain('Could not export context');
    expect(lastFrame() ?? '').toContain('EACCES');
  });
});
