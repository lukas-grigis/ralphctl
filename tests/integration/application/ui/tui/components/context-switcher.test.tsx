/**
 * Context switcher overlay — opened by `S` / `P` through the real `Layout`, over a stubbed view.
 *
 * Covers the grouped-by-project layout (current project first), the selectable project headers,
 * `t` scope / `f` hide-done, cursor navigation and paging, the `setProjectAndSprint` /
 * `setProject` writes, the orphan group, the blocked badge, the `+ New sprint` row, and the
 * contract that the overlay never navigates: `router.stack` is untouched and the view underneath
 * keeps its state.
 */

import React from 'react';
import { Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { END, ENTER, ESC, HOME, PAGE_DOWN, PAGE_UP, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { mountFrame, type AppFrame } from '@tests/integration/application/ui/tui/_app-frame.tsx';
import { stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';
import { absolutePath, makeProject, makeRepository, makeTodoTask, projectId } from '@tests/fixtures/domain.ts';

import type * as SprintBoundModule from '@src/application/ui/shared/launch/sprint-bound.ts';
import type * as StateSnapshotModule from '@src/application/ui/shared/state-snapshot.ts';

const launchSprintBoundFlow = vi.fn();
vi.mock('@src/application/ui/shared/launch/sprint-bound.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SprintBoundModule>()),
  launchSprintBoundFlow: (...args: unknown[]): unknown => launchSprintBoundFlow(...args),
}));
vi.mock('@src/application/ui/shared/state-snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof StateSnapshotModule>()),
  loadAppStateSnapshot: async (): Promise<unknown> => ({}),
}));

beforeEach(() => {
  launchSprintBoundFlow.mockReset();
  launchSprintBoundFlow.mockResolvedValue({ ok: false, reason: 'test stub' });
});

const sprintId = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id fixture: ${r.error.message}`);
  return r.value;
};
const repoId = (s: string): RepositoryId => {
  const r = RepositoryId.parse(s);
  if (!r.ok) throw new Error(`bad repo id fixture: ${r.error.message}`);
  return r.value;
};

const PID_A = projectId('01900000-0000-7000-8000-0000000000a1');
const PID_B = projectId('01900000-0000-7000-8000-0000000000a2');
const PID_C = projectId('01900000-0000-7000-8000-0000000000a3');
const SID_A1 = sprintId('01900000-0000-7000-8000-0000000010a1');
const SID_A2 = sprintId('01900000-0000-7000-8000-0000000020a1');
const SID_B1 = sprintId('01900000-0000-7000-8000-0000000010b1');
const SID_ORPHAN = sprintId('01900000-0000-7000-8000-0000000099ff');

const makeSprint = (o: {
  readonly id: SprintId;
  readonly projectId: Project['id'];
  readonly name: string;
  readonly status?: Sprint['status'];
}): Sprint =>
  ({
    id: o.id,
    slug: o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: o.name,
    projectId: o.projectId,
    status: o.status ?? 'draft',
    tickets: [],
  }) as unknown as Sprint;

const projectAlpha = makeProject({
  id: PID_A,
  displayName: 'Alpha Project',
  slug: 'alpha',
  repositories: [makeRepository({ id: repoId('01900000-0000-7000-8000-000000000fa1'), slug: 'alpha-repo' })],
});
const projectBeta = makeProject({
  id: PID_B,
  displayName: 'Beta Project',
  slug: 'beta',
  repositories: [
    makeRepository({
      id: repoId('01900000-0000-7000-8000-000000000fb1'),
      slug: 'beta-repo',
      path: absolutePath('/tmp/ralph/beta-repo').toString(),
    }),
    makeRepository({
      id: repoId('01900000-0000-7000-8000-000000000fb2'),
      slug: 'beta-repo-2',
      path: absolutePath('/tmp/ralph/beta-repo-2').toString(),
    }),
  ],
});
const projectGamma = makeProject({ id: PID_C, displayName: 'Gamma Project', slug: 'gamma' });

interface DepsOpts {
  readonly sprints?: readonly Sprint[];
  readonly projects?: readonly Project[];
  readonly tasks?: readonly Task[];
  readonly sprintRepo?: SprintRepository;
}

const stubDeps = (o: DepsOpts = {}): AppDeps =>
  ({
    eventBus: createInMemoryEventBus(),
    settingsRepo: { load: async () => Result.ok({}) },
    skillCatalog: { list: async () => Result.ok([]) },
    sprintRepo:
      o.sprintRepo ??
      ({
        async list() {
          return Result.ok([...(o.sprints ?? [])]);
        },
      } as unknown as SprintRepository),
    projectRepo: {
      async list() {
        return Result.ok([...(o.projects ?? [])]);
      },
    } as unknown as ProjectRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...(o.tasks ?? [])]);
      },
    },
  }) as unknown as AppDeps;

/** Records the live selection so tests can read what a switch wrote. */
const selectionRef: { current: ReturnType<typeof useSelection> | undefined } = { current: undefined };
const SelectionTap = (): null => {
  selectionRef.current = useSelection();
  return null;
};
const sel = (): ReturnType<typeof useSelection> => {
  if (selectionRef.current === undefined) throw new Error('selection not mounted');
  return selectionRef.current;
};

/** The view under the overlay — a counter that proves it stays mounted and keeps its state. */
const CounterView = (): React.JSX.Element => {
  const [n, setN] = React.useState(0);
  useViewKeys([{ keys: ['m'], hint: 'bump', run: () => setN((v) => v + 1) }]);
  return (
    <ViewShell title="Work">
      <Text>{`count:${String(n)}`}</Text>
    </ViewShell>
  );
};

const open = async (
  o: DepsOpts,
  opts: {
    readonly key?: 'S' | 'P';
    readonly columns?: number;
    readonly rows?: number;
    readonly selection?: Parameters<typeof mountFrame>[0]['selection'];
    readonly ready?: (frame: string) => boolean;
  } = {}
): Promise<AppFrame> => {
  const f = mountFrame({
    columns: opts.columns ?? 100,
    rows: opts.rows ?? 30,
    deps: stubDeps(o),
    ...(opts.selection !== undefined ? { selection: opts.selection } : {}),
    probe: <SelectionTap />,
    renderRoute: () => <CounterView />,
  });
  await tick(60);
  f.result.stdin.write(opts.key ?? 'S');
  await waitFor(() => {
    const frame = stripAnsi(f.result.lastFrame() ?? '');
    expect(frame).toContain('switch sprint or project');
    if (opts.ready !== undefined) expect(opts.ready(frame)).toBe(true);
    else expect(frame).not.toContain('Loading sprints');
  });
  return f;
};

const frameOf = (f: AppFrame): string => stripAnsi(f.result.lastFrame() ?? '');

/** The row carrying the cursor `▸`. */
const focusedLine = (frame: string): string => frame.split('\n').find((l) => l.includes('▸')) ?? '';

const SEL_A = { projectId: PID_A, projectLabel: 'Alpha Project' } as const;

describe('ContextSwitcher — layout', () => {
  it('carries the ▸ cursor on exactly one row, so focus reads without colour', async () => {
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint one' }),
          makeSprint({ id: SID_A2, projectId: PID_A, name: 'alpha sprint two' }),
        ],
        projects: [projectAlpha],
      },
      { selection: SEL_A }
    );
    expect(
      frameOf(f)
        .split('\n')
        .filter((l) => l.includes('▸'))
    ).toHaveLength(1);
  });

  it('lists every sprint grouped by project, current project first, with counts', async () => {
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint one' }),
          makeSprint({ id: SID_A2, projectId: PID_A, name: 'alpha sprint two' }),
          makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint one' }),
        ],
        projects: [projectBeta, projectAlpha],
      },
      { selection: SEL_A }
    );
    const frame = frameOf(f);
    expect(frame).toContain('3 sprints');
    expect(frame).toContain('2 projects');
    expect(frame).toContain('scope: all projects');
    expect(frame).toContain('ALPHA PROJECT · 1 repo');
    expect(frame).toContain('BETA PROJECT · 2 repos');
    expect(frame.indexOf('ALPHA PROJECT')).toBeLessThan(frame.indexOf('BETA PROJECT'));
    expect(frame).toContain('↵ switch project');
    // DESIGN-SYSTEM §6.4 — arrows only in the hint strip; j/k stays bound but unadvertised.
    expect(frame).not.toContain('j/k');
    f.result.unmount();
  });

  it('renders `no sprints · ↵ switch` on an empty project header', async () => {
    const f = await open(
      {
        sprints: [makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' })],
        projects: [projectAlpha, projectGamma],
      },
      { selection: SEL_A }
    );
    const frame = frameOf(f);
    expect(frame).toContain('GAMMA PROJECT');
    expect(frame).toContain('no sprints · ↵ switch');
    f.result.unmount();
  });

  it('pins its own footer: rule + one hint row naming the switcher keys', async () => {
    const f = await open({ sprints: [], projects: [projectAlpha] }, { selection: SEL_A });
    const lines = f.lines().map(stripAnsi);
    expect(lines.at(-2)).toMatch(/^─+$/);
    const hints = lines.at(-1) ?? '';
    for (const part of ['↑/↓ move', '↵ switch', 'c new sprint', 't scope', 'f hide done', 'esc close']) {
      expect(hints).toContain(part);
    }
    f.result.unmount();
  });

  it('keeps the tab bar and location line on screen above the box', async () => {
    const f = await open({ sprints: [], projects: [projectAlpha] }, { selection: SEL_A });
    const lines = f.lines().map(stripAnsi);
    expect(lines[0]).toContain('[1 Work]');
    expect(lines[1]).toMatch(/^ {2}▣ Work/);
    expect(lines[3]).toMatch(/^ *╭─ S switch sprint or project/);
    f.result.unmount();
  });

  it('is full width below 100 columns, and min(96, columns − 4) from 100, left-aligned', async () => {
    const narrow = await open({ sprints: [], projects: [projectAlpha] }, { selection: SEL_A, columns: 80, rows: 24 });
    const top80 =
      narrow
        .lines()
        .map(stripAnsi)
        .find((l) => l.includes('╭─ S')) ?? '';
    expect(top80.startsWith('╭')).toBe(true);
    expect([...top80.trimEnd()].length).toBe(80);
    narrow.result.unmount();

    const wide = await open({ sprints: [], projects: [projectAlpha] }, { selection: SEL_A, columns: 160, rows: 30 });
    const top160 =
      wide
        .lines()
        .map(stripAnsi)
        .find((l) => l.includes('╭─ S')) ?? '';
    expect(top160.startsWith('  ╭')).toBe(true);
    expect([...top160.trimEnd()].length).toBe(2 + 96);
    wide.result.unmount();
  });
});

describe('ContextSwitcher — opening', () => {
  it('S puts the cursor on the current sprint', async () => {
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha old' }),
          makeSprint({ id: SID_A2, projectId: PID_A, name: 'alpha new' }),
        ],
        projects: [projectAlpha],
      },
      { key: 'S', selection: { ...SEL_A, sprintId: SID_A1, sprintLabel: 'alpha old' } }
    );
    expect(focusedLine(frameOf(f))).toContain('alpha old');
    expect(frameOf(f)).toContain('current');
    f.result.unmount();
  });

  it("P puts the cursor on the current project's header", async () => {
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
          makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint' }),
        ],
        projects: [projectAlpha, projectBeta],
      },
      {
        key: 'P',
        selection: { projectId: PID_B, projectLabel: 'Beta Project', sprintId: SID_B1, sprintLabel: 'beta sprint' },
      }
    );
    expect(focusedLine(frameOf(f))).toContain('BETA PROJECT');
    f.result.unmount();
  });

  it('renders a load-error row when sprintRepo.list() rejects', async () => {
    const sprintRepo = {
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'boom' }));
      },
    } as unknown as SprintRepository;
    const f = await open(
      { sprintRepo, projects: [projectAlpha] },
      { selection: SEL_A, ready: (fr) => fr.includes('Failed to load sprints.') }
    );
    expect(frameOf(f)).toContain('Failed to load sprints.');
    f.result.unmount();
  });
});

describe('ContextSwitcher — switching never navigates', () => {
  const twoProjects: DepsOpts = {
    sprints: [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint' }),
    ],
    projects: [projectAlpha, projectBeta],
  };

  it('↵ on a sprint from another project calls setProjectAndSprint once, closes, and leaves router.stack alone', async () => {
    const f = await open(twoProjects, { selection: { ...SEL_A, sprintId: SID_A1, sprintLabel: 'alpha sprint' } });
    const spy = vi.fn(sel().setProjectAndSprint);
    Object.assign(sel(), { setProjectAndSprint: spy });
    const stackBefore = f.router().stack.map((e) => e.id);

    // alpha sprint → Beta header → beta sprint
    f.result.stdin.write('j');
    await tick(30);
    f.result.stdin.write('j');
    await tick(30);
    expect(focusedLine(frameOf(f))).toContain('beta sprint');
    f.result.stdin.write(ENTER);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    expect(spy.mock.calls[0]?.slice(0, 4)).toEqual([PID_B, 'Beta Project', SID_B1, 'beta sprint']);
    await waitFor(() => expect(frameOf(f)).not.toContain('switch sprint or project'));
    expect(f.router().stack.map((e) => e.id)).toEqual(stackBefore);
    expect(sel().sprintLabel).toBe('beta sprint');
    expect(sel().projectLabel).toBe('Beta Project');
    f.result.unmount();
  });

  it('↵ on a project header sets the project, clears the sprint, and closes without navigating', async () => {
    const f = await open(twoProjects, {
      key: 'P',
      selection: { ...SEL_A, sprintId: SID_A1, sprintLabel: 'alpha sprint' },
    });
    // Alpha header (cursor) → alpha sprint → Beta header
    f.result.stdin.write('j');
    await tick(30);
    f.result.stdin.write('j');
    await tick(30);
    expect(focusedLine(frameOf(f))).toContain('BETA PROJECT');
    f.result.stdin.write(ENTER);
    await waitFor(() => expect(sel().projectLabel).toBe('Beta Project'));
    expect(sel().sprintId).toBeUndefined();
    expect(sel().sprintLabel).toBeUndefined();
    await waitFor(() => expect(frameOf(f)).not.toContain('switch sprint or project'));
    expect(f.router().stack.map((e) => e.id)).toEqual(['home']);
    f.result.unmount();
  });

  it('esc closes and the view underneath keeps its state', async () => {
    const f = await open(twoProjects, { selection: SEL_A });
    f.result.stdin.write(ESC);
    await waitFor(() => expect(frameOf(f)).toContain('count:0'));
    f.result.stdin.write('m');
    await waitFor(() => expect(frameOf(f)).toContain('count:1'));

    f.result.stdin.write('S');
    await waitFor(() => expect(frameOf(f)).toContain('switch sprint or project'));
    f.result.stdin.write(ESC);
    await waitFor(() => expect(frameOf(f)).toContain('count:1'));
    expect(frameOf(f)).not.toContain('switch sprint or project');
    expect(f.router().stack.map((e) => e.id)).toEqual(['home']);
    f.result.unmount();
  });

  it('keys typed in the switcher do not reach the view underneath', async () => {
    const f = await open(twoProjects, { selection: SEL_A });
    f.result.stdin.write('m');
    await tick(40);
    f.result.stdin.write(ESC);
    await waitFor(() => expect(frameOf(f)).toContain('count:0'));
    f.result.unmount();
  });

  it('an orphan sprint (its project was deleted) switches with a plain setSprint', async () => {
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
          makeSprint({ id: SID_ORPHAN, projectId: PID_C, name: 'lonely sprint' }),
        ],
        projects: [projectAlpha],
      },
      { selection: SEL_A }
    );
    const frame = frameOf(f);
    expect(frame).toContain('UNKNOWN PROJECT');
    expect(frame).toContain('⚠');
    expect(frame).toContain('lonely sprint');
    // The orphan header is not a cursor target: ↓ from the alpha sprint lands on the lonely sprint.
    f.result.stdin.write('j');
    await tick(30);
    expect(focusedLine(frameOf(f))).toContain('lonely sprint');
    f.result.stdin.write(ENTER);
    await waitFor(() => expect(sel().sprintLabel).toBe('lonely sprint'));
    expect(sel().projectLabel).toBe('Alpha Project');
    f.result.unmount();
  });
});

describe('ContextSwitcher — scope and filters', () => {
  const mixed: DepsOpts = {
    sprints: [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'live sprint' }),
      makeSprint({ id: SID_A2, projectId: PID_A, name: 'closed sprint', status: 'done' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint' }),
    ],
    projects: [projectAlpha, projectBeta],
  };

  it('t scopes to the current project and back', async () => {
    const f = await open(mixed, { selection: SEL_A });
    expect(frameOf(f)).toContain('BETA PROJECT');
    f.result.stdin.write('t');
    await waitFor(() => expect(frameOf(f)).toContain('scope: current'));
    expect(frameOf(f)).not.toContain('BETA PROJECT');
    expect(frameOf(f)).toContain('2 sprints');
    f.result.stdin.write('t');
    await waitFor(() => expect(frameOf(f)).toContain('BETA PROJECT'));
    f.result.unmount();
  });

  it('f hides done sprints and shows them again', async () => {
    const f = await open(mixed, { selection: SEL_A });
    expect(frameOf(f)).toContain('closed sprint');
    expect(frameOf(f)).toContain('f hide done: off');
    f.result.stdin.write('f');
    await waitFor(() => expect(frameOf(f)).not.toContain('closed sprint'));
    expect(frameOf(f)).toContain('f hide done: on');
    f.result.stdin.write('f');
    await waitFor(() => expect(frameOf(f)).toContain('closed sprint'));
    f.result.unmount();
  });

  it('f does not teleport the cursor off a manually navigated row', async () => {
    const SID_NEW = sprintId('01900000-0000-7000-8000-000000030000');
    const SID_MID = sprintId('01900000-0000-7000-8000-000000020000');
    const SID_OLD = sprintId('01900000-0000-7000-8000-000000010000');
    const f = await open(
      {
        sprints: [
          makeSprint({ id: SID_NEW, projectId: PID_A, name: 'live-new sprint' }),
          makeSprint({ id: SID_MID, projectId: PID_A, name: 'closed-mid sprint', status: 'done' }),
          makeSprint({ id: SID_OLD, projectId: PID_A, name: 'live-old sprint' }),
        ],
        projects: [projectAlpha],
      },
      { selection: { ...SEL_A, sprintId: SID_OLD, sprintLabel: 'live-old sprint' } }
    );
    expect(focusedLine(frameOf(f))).toContain('live-old sprint');
    f.result.stdin.write('k');
    await tick(20);
    f.result.stdin.write('k');
    await waitFor(() => expect(focusedLine(frameOf(f))).toContain('live-new sprint'));
    f.result.stdin.write('f');
    await waitFor(() => expect(frameOf(f)).not.toContain('closed-mid sprint'));
    expect(focusedLine(frameOf(f))).toContain('live-new sprint');
    f.result.unmount();
  });

  it('names the f escape hatch when the filter hid everything in scope', async () => {
    const f = await open(
      { sprints: [makeSprint({ id: SID_A2, projectId: PID_A, name: 'closed sprint', status: 'done' })], projects: [] },
      { selection: {} }
    );
    expect(frameOf(f)).toContain('closed sprint');
    f.result.stdin.write('f');
    await waitFor(() => expect(frameOf(f)).toContain('done (hidden)'));
    expect(frameOf(f)).toContain('Press f to show them');
    f.result.unmount();
  });
});

describe('ContextSwitcher — blocked badge', () => {
  const blockedTask = (name: string): Task => {
    const r = markTaskBlocked(makeTodoTask({ name }), 'stuck', 'own');
    if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
    return r.value;
  };
  const stuck = makeSprint({ id: SID_A1, projectId: PID_A, name: 'stuck sprint', status: 'active' });

  it('shows `⚠ N blocked` on the sprint row, focused or not', async () => {
    const f = await open(
      {
        sprints: [stuck, makeSprint({ id: SID_A2, projectId: PID_A, name: 'other sprint' })],
        projects: [projectAlpha],
        tasks: [blockedTask('one'), blockedTask('two')],
      },
      { selection: SEL_A }
    );
    const line =
      frameOf(f)
        .split('\n')
        .find((l) => l.includes('stuck sprint')) ?? '';
    expect(line).toContain('⚠ 2 blocked');
    f.result.unmount();
  });

  it('omits the badge when nothing is blocked', async () => {
    const f = await open(
      { sprints: [stuck], projects: [projectAlpha], tasks: [makeTodoTask({ name: 'runnable' })] },
      { selection: SEL_A }
    );
    expect(frameOf(f)).toContain('stuck sprint');
    expect(frameOf(f)).not.toContain('blocked');
    f.result.unmount();
  });
});

describe('ContextSwitcher — + New sprint row', () => {
  const oneSprint: DepsOpts = {
    sprints: [makeSprint({ id: SID_A1, projectId: PID_A, name: 'existing sprint' })],
    projects: [projectAlpha],
  };

  it('is the first row, names the project, and sits before the project headers', async () => {
    const f = await open(oneSprint, { selection: SEL_A });
    const lines = frameOf(f).split('\n');
    const create = lines.findIndex((l) => l.includes('+ New sprint in Alpha Project'));
    const header = lines.findIndex((l) => l.includes('ALPHA PROJECT'));
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(header);
    f.result.unmount();
  });

  it('c closes the overlay and launches create-sprint', async () => {
    const f = await open(oneSprint, { selection: SEL_A });
    f.result.stdin.write('c');
    await waitFor(() => expect(launchSprintBoundFlow).toHaveBeenCalledTimes(1));
    expect(launchSprintBoundFlow.mock.calls[0]?.[1]).toBe('create-sprint');
    await waitFor(() => expect(frameOf(f)).not.toContain('switch sprint or project'));
    f.result.unmount();
  });

  it('↵ on the create row launches create-sprint too', async () => {
    const f = await open(oneSprint, { selection: SEL_A });
    f.result.stdin.write(HOME);
    await waitFor(() => expect(focusedLine(frameOf(f))).toContain('+ New sprint'));
    f.result.stdin.write(ENTER);
    await waitFor(() => expect(launchSprintBoundFlow).toHaveBeenCalledTimes(1));
    f.result.unmount();
  });

  it('is not offered without a current project, and c says so instead of launching', async () => {
    const f = await open(oneSprint, { selection: {} });
    expect(frameOf(f)).not.toContain('+ New sprint');
    f.result.stdin.write('c');
    await waitFor(() => expect(frameOf(f)).toContain('select a project first'));
    expect(launchSprintBoundFlow).not.toHaveBeenCalled();
    expect(frameOf(f)).toContain('switch sprint or project');
    f.result.unmount();
  });
});

describe('ContextSwitcher — long lists', () => {
  const manySprints = (): readonly Sprint[] =>
    Array.from({ length: 30 }, (_u, i) => {
      const suffix = String(i + 1).padStart(2, '0');
      return makeSprint({
        id: sprintId(`01900000-0000-7000-8000-0000000100${suffix}`),
        projectId: PID_A,
        name: `switchsprint-${suffix}`,
      });
    });
  const focusedNum = (frame: string): number => {
    const m = /switchsprint-(\d{2})/.exec(focusedLine(frame));
    return m?.[1] !== undefined ? Number(m[1]) : NaN;
  };

  it('PageDown / PageUp page by the visible window', async () => {
    const f = await open({ sprints: manySprints(), projects: [projectAlpha] }, { selection: SEL_A, rows: 24 });
    // No current sprint: the cursor lands on the first (newest) sprint row.
    expect(focusedNum(frameOf(f))).toBe(30);

    f.result.stdin.write(PAGE_DOWN);
    await waitFor(() => expect(focusedNum(frameOf(f))).toBeLessThan(29));
    expect(focusedNum(frameOf(f))).toBeGreaterThan(1);

    f.result.stdin.write(PAGE_UP);
    await waitFor(() => expect(focusedNum(frameOf(f))).toBeGreaterThanOrEqual(29));
    f.result.unmount();
  });

  it('Home jumps to the create row, End to the last sprint', async () => {
    const f = await open({ sprints: manySprints(), projects: [projectAlpha] }, { selection: SEL_A, rows: 24 });
    f.result.stdin.write(END);
    await waitFor(() => expect(focusedLine(frameOf(f))).toContain('switchsprint-01'));
    f.result.stdin.write(HOME);
    await waitFor(() => expect(focusedLine(frameOf(f))).toContain('+ New sprint'));
    f.result.unmount();
  });

  it('project headers are cursor targets and stay on screen — 40 projects, End lands on the last header', async () => {
    const projects = Array.from({ length: 40 }, (_u, i) => {
      const suffix = String(i + 1).padStart(2, '0');
      return makeProject({
        id: projectId(`01900000-0000-7000-8000-0000000e00${suffix}`),
        displayName: `Project ${suffix}`,
        slug: `project-${suffix}`,
      });
    });
    const f = await open({ sprints: [], projects }, { key: 'P', selection: {}, rows: 24 });
    expect(frameOf(f)).not.toContain('PROJECT 40');
    f.result.stdin.write(END);
    await waitFor(() => expect(focusedLine(frameOf(f))).toContain('PROJECT 40'));
    expect(frameOf(f)).toContain('more');
    f.result.unmount();
  });

  it('render height stays bounded even with many empty project groups', async () => {
    const empties = Array.from({ length: 20 }, (_u, i) => {
      const n = String(i + 1).padStart(2, '0');
      return makeProject({
        id: projectId(`01900000-0000-7000-8000-0000000e00${n}`),
        displayName: `Empty${n}`,
        slug: `empty-${n}`,
      });
    });
    const f = await open(
      {
        sprints: [makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint one' })],
        projects: [projectAlpha, ...empties],
      },
      { selection: { ...SEL_A, sprintId: SID_A1, sprintLabel: 'alpha sprint one' }, rows: 24 }
    );
    const frame = frameOf(f);
    expect(frame).toContain('EMPTY01');
    expect(frame).not.toContain('EMPTY20');
    expect(f.lines()).toHaveLength(24);
    f.result.unmount();
  });
});
