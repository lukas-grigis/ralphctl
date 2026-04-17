import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Project, Sprint, Tasks } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const resolveSprintIdMock = vi.fn<(id?: string) => Promise<string>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const listTasksMock = vi.fn<(id?: string) => Promise<Tasks>>();
const getProjectByIdMock = vi.fn<(id: string) => Promise<Project>>();

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  resolveSprintId: (id?: string) => resolveSprintIdMock(id),
  getSprint: (id: string) => getSprintMock(id),
}));
vi.mock('@src/integration/persistence/task.ts', () => ({
  listTasks: (id?: string) => listTasksMock(id),
}));
vi.mock('@src/integration/persistence/project.ts', () => ({
  getProjectById: (id: string) => getProjectByIdMock(id),
}));

import { SprintShowView } from './sprint-show-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    name: 'Demo Sprint',
    projectId: 'p1',
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

function project(): Project {
  return { id: 'p1', name: 'demo', displayName: 'Demo', repositories: [{ id: 'r1', name: 'app', path: '/tmp/app' }] };
}

const router: RouterApi = {
  current: { id: 'sprint-show' },
  stack: [{ id: 'home' }, { id: 'sprint-show' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={router}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe('SprintShowView', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the hub with default sections', async () => {
    resolveSprintIdMock.mockResolvedValue('s1');
    getSprintMock.mockResolvedValue(sprint());
    listTasksMock.mockResolvedValue([]);
    getProjectByIdMock.mockResolvedValue(project());

    const { lastFrame } = render(withRouter(<SprintShowView sprintId="s1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Demo Sprint');
    expect(frame).toContain('Tickets');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Progress log');
    expect(frame).toContain('Evaluations');
    expect(frame).toContain('Feedback');
    expect(frame).toContain('Delete');
  });

  it('shows Reactivate on closed sprints', async () => {
    resolveSprintIdMock.mockResolvedValue('s1');
    getSprintMock.mockResolvedValue(sprint({ status: 'closed', closedAt: '2026-04-17T00:00:00Z' }));
    listTasksMock.mockResolvedValue([]);
    getProjectByIdMock.mockResolvedValue(project());

    const { lastFrame } = render(withRouter(<SprintShowView sprintId="s1" />));
    await flush();

    expect(lastFrame() ?? '').toContain('Reactivate');
  });

  it('hides Delete on active sprints', async () => {
    resolveSprintIdMock.mockResolvedValue('s1');
    getSprintMock.mockResolvedValue(sprint({ status: 'active' }));
    listTasksMock.mockResolvedValue([]);
    getProjectByIdMock.mockResolvedValue(project());

    const { lastFrame } = render(withRouter(<SprintShowView sprintId="s1" />));
    await flush();

    const frame = lastFrame() ?? '';
    // Status chip uppercases; check for the section-row "Delete — …" label
    expect(frame).not.toMatch(/Delete\s+—/);
  });
});
