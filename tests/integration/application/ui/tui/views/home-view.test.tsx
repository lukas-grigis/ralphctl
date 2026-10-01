/**
 * Work (HomeView): the hero cards for the no-project / no-sprint states, and the agenda —
 * NEEDS YOU → RUNNING → NEXT → FLOWS — with ↵ doing the focused row's job. Layout cases render
 * at real sizes; the launcher and the unblock hook are mocked so ↵ / u are observable.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';
import { DOWN, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, stripAnsi, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(async (flowId: string) => void flowId),
  unblock: vi.fn(async () => ({ ok: true, value: {} })),
}));

vi.mock('@src/application/ui/tui/runtime/use-flow-launcher.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFlowLauncher: () => ({
    launch: mocks.launch,
    launchability: () => ({ ok: true }),
    launchError: undefined,
  }),
}));
vi.mock('@src/application/ui/tui/runtime/use-unblock-task.ts', () => ({ useUnblockTask: () => mocks.unblock }));

const baseDeps = (overrides: Partial<AppDeps>): AppDeps =>
  ({
    eventBus: createInMemoryEventBus(),
    projectRepo: {
      async list() {
        return Result.ok([]);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([]);
      },
    } as unknown as SprintRepository,
    sprintExecutionRepo: {
      async findById(id: unknown) {
        return Result.error(
          new NotFoundError({ entity: 'sprint-execution', id: String(id), message: 'no executions' })
        );
      },
    } as unknown as SprintExecutionRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    settingsRepo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
      async save() {
        return Result.ok(undefined);
      },
    } as unknown as SettingsRepository,
    ...overrides,
  }) as unknown as AppDeps;

const project = makeProject({ displayName: 'Mainline' });
const sprint = { ...makeActiveSprint(), projectId: project.id, name: 'Sprint One' } as unknown as Sprint;

const blockedTask = (): Task => {
  const todo = makeTodoTask({ name: 'Add a --name CLI test', order: 1 });
  const r = markTaskBlocked({ ...todo, id: 'task-blocked-1' as TaskId }, 'pytest exited 1 after 3 attempts', 'own');
  if (!r.ok) throw new Error('fixture');
  return r.value;
};

const workDeps = (tasks: readonly Task[] = [blockedTask(), makeTodoTask({ name: 'Wire formatter', order: 2 })]) =>
  baseDeps({
    projectRepo: {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([sprint]);
      },
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
  });

const selected = {
  projectId: project.id,
  projectLabel: project.displayName,
  sprintId: sprint.id,
  sprintLabel: sprint.name,
};

/** Pin the root to the terminal height, as the real App does, so ScrollRegion actually clips. */
const Framed = ({ rows, children }: { readonly rows: number; readonly children: React.ReactNode }) => (
  <Box flexDirection="column" height={rows}>
    {children}
  </Box>
);

const renderWork = (columns: number, rows: number, extra?: React.ReactNode, deps: AppDeps = workDeps()) => {
  const entries: Array<{ readonly id: string; readonly props?: Record<string, unknown> }> = [];
  const api = renderView(
    <Framed rows={rows}>
      {extra}
      <HomeView />
    </Framed>,
    {
      deps,
      initial: { id: 'home' },
      selection: selected,
      size: { columns, rows },
      onRoute: (entry) => {
        entries.push(entry);
      },
    }
  );
  return { ...api, entries };
};

const lineOf = (frame: string, needle: string): string => frame.split('\n').find((l) => l.includes(needle)) ?? '';

describe('HomeView — heroes', () => {
  it('shows the create-project CTA when no projects exist', async () => {
    const { result } = renderView(<HomeView />, { deps: baseDeps({}), initial: { id: 'home' } });
    await waitForViewReady(result, (f) => f.includes('Start by creating a project'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/create your first project/);
    result.unmount();
  });

  it('shows the sprint-creation CTA and the project flows when a project is selected but no sprint', async () => {
    const projectRepo = {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository;
    const { result } = renderView(<HomeView />, {
      deps: baseDeps({ projectRepo }),
      initial: { id: 'home' },
      selection: { projectId: project.id, projectLabel: project.displayName },
    });
    await waitForViewReady(result, (f) => f.includes('Mainline'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/open Sprints/);
    expect(frame).toContain('FLOWS');
    result.unmount();
  });
});

describe('Work at 80x24 with one blocked task', () => {
  it('seeds the cursor on the blocked row and leads the footer with ↵ open task', async () => {
    const { result } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/▸ △ "Add a --name CLI test" is blocked/);
    expect(frame).toContain('NEEDS YOU  1');
    expect(frame).toContain('pytest exited 1 after 3 attempts');
    expect(frame).toMatch(/↵ open task · u unblock/);
  });

  it('shows every flow row and none of the old menu, without scrolling', async () => {
    const { result } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('FLOWS'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Export requirements');
    expect(frame).toContain('NEXT');
    expect(frame).not.toMatch(/▴ \d+ more/);
    for (const old of ['WORK', 'OBSERVE', 'SYSTEM', 'SWITCH SPRINT']) expect(frame).not.toContain(old);
  });

  it('↵ on the blocked row opens sprint detail focused on that task', async () => {
    const { result, entries } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    result.stdin.write(ENTER);
    await waitForPredicate(() => entries.at(-1)?.id === 'sprint-detail');
    expect(entries.at(-1)?.props).toMatchObject({ sprintId: sprint.id, focusTaskId: 'task-blocked-1' });
  });

  it('u unblocks the focused blocked task', async () => {
    mocks.unblock.mockClear();
    const { result } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    result.stdin.write('u');
    await waitForPredicate(() => mocks.unblock.mock.calls.length > 0);
    expect(mocks.unblock).toHaveBeenCalledTimes(1);
  });

  it('u is not offered once the cursor leaves a blocked row', async () => {
    const { result } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    result.stdin.write(DOWN);
    await waitForPredicate(() => /↵ run Implement/.test(result.lastFrame() ?? ''));
    expect(result.lastFrame() ?? '').not.toMatch(/u unblock/);
  });

  it('↵ on the NEXT row launches the flow through the shared launcher', async () => {
    mocks.launch.mockClear();
    const { result } = renderWork(80, 24);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    result.stdin.write(DOWN);
    await waitForPredicate(() => /▸ ◆ Implement/.test(result.lastFrame() ?? ''));
    result.stdin.write(ENTER);
    await waitForPredicate(() => mocks.launch.mock.calls.length > 0);
    expect(mocks.launch).toHaveBeenCalledWith('implement');
  });

  it('draws no cursor while a prompt is queued', async () => {
    const ClaimPrompt = (): React.JSX.Element => {
      const { claimPrompt } = useUiState();
      React.useEffect(() => claimPrompt(), [claimPrompt]);
      return <Text> </Text>;
    };
    const { result } = renderWork(80, 24, <ClaimPrompt />);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('is blocked'));
    await tick(50);
    expect(result.lastFrame() ?? '').not.toContain('▸');
  });
});

describe('Work at larger sizes', () => {
  it('160x45 adds the glance column and keeps the wordmark', async () => {
    const { result } = renderWork(160, 45);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('RECENT SPRINTS'));
    const frame = stripAnsi(result.lastFrame() ?? '');
    expect(frame).toContain('██████╗');
    const tasks = lineOf(frame, 'TASKS');
    expect(tasks.indexOf('TASKS')).toBeGreaterThan(100);
    expect(tasks).toContain('TASKS  2');
    expect(frame).toContain('S switch');
    expect(frame).toContain('NEEDS YOU');
  });

  it('120x45 is a single column with no TASKS panel', async () => {
    const { result } = renderWork(120, 45);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('FLOWS'));
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('TASKS');
    expect(frame).not.toContain('RECENT SPRINTS');
  });
});
