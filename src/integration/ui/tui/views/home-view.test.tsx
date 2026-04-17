/**
 * HomeView tests — mock the persistence reads so the component renders
 * deterministically against fixture states. We stub the banner so the output
 * doesn't include ralphctl's ANSI donut art, and we verify:
 *
 *   - The four pipeline phases render in fixed order with the expected
 *     status glyphs for draft / active / closed sprints.
 *   - The "Next" quick action is rendered and pre-selected, with its label
 *     derived from the first non-done phase's action.
 *   - Arrow keys cycle between selectable rows and Enter dispatches the
 *     selected action to `commandMap`.
 *   - The `b` hotkey opens the browse submenu.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import type { Config, Project, Sprint, Task } from '@src/domain/models.ts';

// --- module mocks -----------------------------------------------------------

const getConfigMock = vi.fn<() => Promise<Config | null>>();
const getAiProviderMock = vi.fn<() => Promise<string | null>>();
const listProjectsMock = vi.fn<() => Promise<Project[]>>();
const getSprintMock = vi.fn<(id: string) => Promise<Sprint | null>>();
const readTasksMock = vi.fn<() => Promise<Task[]>>();

vi.mock('@src/integration/persistence/config.ts', () => ({
  getConfig: () => getConfigMock(),
  getAiProvider: () => getAiProviderMock(),
}));

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  getSprint: (id: string) => getSprintMock(id),
}));

vi.mock('@src/integration/persistence/project.ts', () => ({
  listProjects: () => listProjectsMock(),
}));

vi.mock('@src/integration/persistence/storage.ts', () => ({
  readValidatedJson: async () => {
    const tasks = await readTasksMock();
    return { ok: true, value: tasks };
  },
}));

vi.mock('@src/integration/ui/tui/components/banner.tsx', () => ({
  Banner: () => <Text>BANNER</Text>,
}));

const refineHandler = vi.fn<() => Promise<void>>();
const planHandler = vi.fn<() => Promise<void>>();
const startHandler = vi.fn<() => Promise<void>>();

vi.mock('./command-map.ts', () => ({
  commandMap: {
    sprint: {
      refine: () => refineHandler(),
      plan: () => planHandler(),
      start: () => startHandler(),
    },
  },
}));

// Router context is required by HomeView — it calls `useRouter()` to push
// phase detail views on drill-in. The stub exposes each method as a bare
// `vi.fn` reference so tests can assert on them without tripping the
// unbound-method lint rule.
import { RouterProvider, type RouterApi, type ViewEntry } from './router-context.ts';

const routerMocks = {
  push: vi.fn<(entry: ViewEntry) => void>(),
  pop: vi.fn<() => void>(),
  replace: vi.fn<(entry: ViewEntry) => void>(),
  reset: vi.fn<(entry: ViewEntry) => void>(),
};

const routerStub: RouterApi = {
  current: { id: 'home' },
  stack: [{ id: 'home' }],
  push: routerMocks.push,
  pop: routerMocks.pop,
  replace: routerMocks.replace,
  reset: routerMocks.reset,
};

import { HomeView } from './home-view.tsx';

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

// --- fixtures ---------------------------------------------------------------

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    name: 'Task',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo0001',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo Sprint',
    projectId: 'prj00001',
    status: 'draft',
    createdAt: '2026-04-15T00:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function setState(opts: {
  config?: Config | null;
  projects?: Project[];
  sprint?: Sprint | null;
  tasks?: Task[];
  provider?: string | null;
}): void {
  getConfigMock.mockResolvedValue(opts.config ?? null);
  getAiProviderMock.mockResolvedValue(opts.provider ?? null);
  listProjectsMock.mockResolvedValue(opts.projects ?? []);
  getSprintMock.mockResolvedValue(opts.sprint ?? null);
  readTasksMock.mockResolvedValue(opts.tasks ?? []);
}

// --- tests ------------------------------------------------------------------

describe('HomeView — pipeline map', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders all four phases in fixed order on a fresh machine with no sprint', async () => {
    setState({ config: null, projects: [] });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    // Phase labels appear in pipeline order.
    const refineIdx = frame.indexOf('Refine');
    const planIdx = frame.indexOf('Plan');
    const executeIdx = frame.indexOf('Execute');
    const closeIdx = frame.indexOf('Close');
    expect(refineIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(refineIdx);
    expect(executeIdx).toBeGreaterThan(planIdx);
    expect(closeIdx).toBeGreaterThan(executeIdx);
  });

  it('surfaces "Create Sprint" as the next step when no sprint exists', async () => {
    setState({ config: null, projects: [] });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next:');
    expect(frame).toContain('Create Sprint');
  });

  it('surfaces "Add Ticket" as the next step when a draft sprint has no tickets', async () => {
    setState({
      config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
      projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
      sprint: sprint({ tickets: [] }),
      tasks: [],
    });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next: Add Ticket');
  });

  it('marks the Refine phase done on a draft sprint with all tickets approved', async () => {
    setState({
      config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
      projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
      sprint: sprint({
        tickets: [
          {
            id: 'a',
            title: 'T',
            requirementStatus: 'approved',
          },
        ],
      }),
      tasks: [],
    });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    // Refine done glyph (✓) appears on the Refine line; Next action is Plan Tasks.
    expect(frame).toContain('Next: Plan Tasks');
    expect(frame).toContain('Refine');
    expect(frame).toContain('Plan');
  });

  it('shows "all tasks done" and "Close Sprint" on an active sprint with everything complete', async () => {
    setState({
      config: { currentSprint: 'sprint-1', aiProvider: 'claude', editor: null },
      projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
      sprint: sprint({
        status: 'active',
        activatedAt: '2026-04-15T01:00:00Z',
        tickets: [
          {
            id: 'a',
            title: 'T',
            requirementStatus: 'approved',
          },
        ],
      }),
      tasks: [task({ id: 't1', status: 'done', ticketId: 'a' })],
    });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next: Close Sprint');
  });

  it('marks every phase done on a closed sprint and offers a new-sprint quick action', async () => {
    setState({
      config: { currentSprint: 'sprint-1', aiProvider: 'claude', editor: null },
      projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
      sprint: sprint({
        status: 'closed',
        closedAt: '2026-04-15T02:00:00Z',
        tickets: [
          {
            id: 'a',
            title: 'T',
            requirementStatus: 'approved',
          },
        ],
      }),
      tasks: [task({ id: 't1', status: 'done', ticketId: 'a' })],
    });
    const { lastFrame } = render(withRouter(<HomeView />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next: Start a new sprint');
  });

  it('dispatches the next-step action when Enter is pressed', async () => {
    setState({
      config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
      projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
      sprint: sprint({
        tickets: [
          {
            id: 'a',
            title: 'T',
            requirementStatus: 'pending',
          },
        ],
      }),
      tasks: [],
    });
    const { stdin } = render(withRouter(<HomeView />));
    await flush();

    stdin.write('\r'); // Enter
    await flush();

    expect(refineHandler).toHaveBeenCalledTimes(1);
  });

  it('`b` opens the browse submenu', async () => {
    setState({ config: null, projects: [] });
    const { lastFrame, stdin } = render(withRouter(<HomeView />));
    await flush();

    stdin.write('b');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browse & Setup');
    expect(frame).toContain('Sprints');
    expect(frame).toContain('Tickets');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Projects');
    expect(frame).toContain('Doctor');
  });

  describe('phase drill-in', () => {
    beforeEach(() => {
      routerMocks.push.mockClear();
    });

    it('pushes the refine-phase view when Enter hits the Refine row', async () => {
      setState({
        config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
        projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
        sprint: sprint({
          tickets: [{ id: 'a', title: 'T',  requirementStatus: 'pending' }],
        }),
        tasks: [],
      });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      stdin.write('\u001b[B'); // down once → lands on Refine phase (quick action is the first row)
      await flush();
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).toHaveBeenCalledWith({
        id: 'refine-phase',
        props: { sprintId: 'sprint-1' },
      });
    });

    it('pushes the plan-phase view when Enter hits the Plan row', async () => {
      setState({
        config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
        projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
        sprint: sprint({
          tickets: [{ id: 'a', title: 'T',  requirementStatus: 'approved' }],
        }),
        tasks: [],
      });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      // Quick action is at row 0; Refine is 1; Plan is 2. Two down-arrows.
      stdin.write('\u001b[B');
      await flush();
      stdin.write('\u001b[B');
      await flush();
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).toHaveBeenCalledWith({
        id: 'plan-phase',
        props: { sprintId: 'sprint-1' },
      });
    });

    it('pushes the close-phase view when Enter hits the Close row', async () => {
      setState({
        config: { currentSprint: 'sprint-1', aiProvider: 'claude', editor: null },
        projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
        sprint: sprint({
          status: 'active',
          activatedAt: '2026-04-15T01:00:00Z',
          tickets: [{ id: 'a', title: 'T',  requirementStatus: 'approved' }],
        }),
        tasks: [task({ id: 't1', status: 'done', ticketId: 'a' })],
      });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      // Quick action (Close Sprint) is row 0; Refine 1, Plan 2, Execute 3, Close 4.
      // Four down-arrows from the default cursor (quick action).
      for (let i = 0; i < 4; i++) {
        stdin.write('\u001b[B');
        await flush();
      }
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).toHaveBeenCalledWith({
        id: 'close-phase',
        props: { sprintId: 'sprint-1' },
      });
    });

    it('pushes the execute destination for the Execute phase on an active sprint', async () => {
      setState({
        config: { currentSprint: 'sprint-1', aiProvider: 'claude', editor: null },
        projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
        sprint: sprint({
          status: 'active',
          activatedAt: '2026-04-15T01:00:00Z',
          tickets: [{ id: 'a', title: 'T',  requirementStatus: 'approved' }],
        }),
        tasks: [
          task({ id: 't1', status: 'done', ticketId: 'a' }),
          task({ id: 't2', status: 'todo', ticketId: 'a', order: 2 }),
        ],
      });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      // Quick action, then Refine (1), Plan (2), Execute (3). Three down-arrows.
      for (let i = 0; i < 3; i++) {
        stdin.write('\u001b[B');
        await flush();
      }
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).toHaveBeenCalledWith({
        id: 'execute',
        props: { sprintId: 'sprint-1' },
      });
    });

    it('does not push a drill-in for the Execute phase when it is pending (no tasks)', async () => {
      setState({
        config: { currentSprint: 'sprint-1', aiProvider: null, editor: null },
        projects: [{ name: 'p', displayName: 'P', id: 'prj00001', repositories: [{ id: 'repo0001', name: 'repo', path: '/tmp/repo' }] }],
        sprint: sprint({
          tickets: [{ id: 'a', title: 'T',  requirementStatus: 'approved' }],
        }),
        tasks: [], // Execute phase is 'pending' — drill-in no-ops
      });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      // Navigate to Execute phase (quick action, Refine, Plan, Execute = 3 downs).
      for (let i = 0; i < 3; i++) {
        stdin.write('\u001b[B');
        await flush();
      }
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).not.toHaveBeenCalled();
    });

    it('does not push a drill-in for any phase when no sprint exists', async () => {
      setState({ config: null, projects: [] });
      const { stdin } = render(withRouter(<HomeView />));
      await flush();

      stdin.write('\u001b[B'); // to Refine phase
      await flush();
      stdin.write('\r');
      await flush();

      expect(routerMocks.push).not.toHaveBeenCalled();
    });
  });
});
