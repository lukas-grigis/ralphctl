/**
 * Smoke tests for SprintsView. Empty state, populated row, `c` advice when no project picked.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { END, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const fakeSprintRepo = (sprints: readonly Sprint[]): SprintRepository =>
  ({
    async list() {
      return Result.ok([...sprints]);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;

/** Minimal task repo that returns an empty task list for any sprint. */
const emptyTaskRepo = (): TaskRepository =>
  ({
    async findBySprintId() {
      return Result.ok([] as readonly Task[]);
    },
  }) as unknown as TaskRepository;

const stubDeps = (sprints: readonly Sprint[]): AppDeps =>
  ({
    sprintRepo: fakeSprintRepo(sprints),
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    taskRepo: emptyTaskRepo(),
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const makeSprint = (overrides: Record<string, unknown> = {}): Sprint =>
  ({
    id: 'sprint-id',
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj',
    status: 'draft',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

describe('SprintsView', () => {
  it('shows the empty state when no sprints exist (no project picked)', async () => {
    const { result } = renderView(<SprintsView />, { deps: stubDeps([]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No sprints yet');
    expect(frame).toContain('Pick a project first');
    result.unmount();
  });

  it('renders one row per sprint with name, status, ticket count', async () => {
    const sprint = makeSprint({ name: 'Spring Sprint', slug: 'spring' });
    const { result } = renderView(<SprintsView />, { deps: stubDeps([sprint]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Spring Sprint');
    expect(frame).toContain('spring');
    expect(frame).toMatch(/DRAFT/i);
    expect(frame).toContain('1 sprint(s)');
    result.unmount();
  });

  it('publishes c / d / r hints to the status bar', async () => {
    const sprint = makeSprint({});
    const { result } = renderView(<SprintsView />, { deps: stubDeps([sprint]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('c create');
    expect(frame).toContain('d delete');
    expect(frame).toContain('e rename');
    result.unmount();
  });

  it('hides the e rename hint when the focused sprint is done (rename guards status !== done)', async () => {
    const done = makeSprint({ name: 'Shipped Sprint', status: 'done' });
    const { result } = renderView(<SprintsView />, { deps: stubDeps([done]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // The rename handler is a no-op on a done sprint, so the hint must hide rather than advertise
    // a dead key — hint and handler share one source of truth.
    expect(frame).toContain('Shipped Sprint');
    expect(frame).not.toContain('e rename');
    result.unmount();
  });

  it("pressing 'e' on a done sprint flashes a reason instead of a silent no-op", async () => {
    const done = makeSprint({ name: 'Shipped Sprint', status: 'done' });
    const { result } = renderView(<SprintsView />, { deps: stubDeps([done]), initial: { id: 'sprints' } });
    await tick(40);
    result.stdin.write('e');
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // Someone who found `e` via `?` should learn why it's inert, not be left guessing.
    expect(frame).toContain("done sprints can't be renamed");
    result.unmount();
  });

  it("pressing 'e' opens an Ink text prompt prefilled with the sprint name and saves on resolve", async () => {
    const sprint = makeDraftSprint({ name: 'Mispeld Sprint' });
    const save = vi.fn(async (s: Sprint) => Result.ok<Sprint>(s));
    const repo = {
      async list() {
        return Result.ok([sprint] as readonly Sprint[]);
      },
      async findById() {
        return Result.ok(sprint);
      },
      save,
      async remove() {
        return Result.ok(undefined);
      },
    } as unknown as SprintRepository;
    const queue = createPromptQueue();
    const deps = stubDeps([sprint]);
    (deps as unknown as { sprintRepo: SprintRepository }).sprintRepo = repo;
    const { result } = renderView(<SprintsView />, { deps, initial: { id: 'sprints' }, queue });
    await tick(40);
    result.stdin.write('e');
    await tick(40);
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('Mispeld Sprint');
    }
    queue.resolveHead('Misspelled Sprint');
    await tick(40);
    expect(save).toHaveBeenCalledTimes(1);
    const renamed = save.mock.calls[0]?.[0];
    expect(renamed?.name).toBe('Misspelled Sprint');
    result.unmount();
  });

  it("shows 'u unblock (N)' hint when the focused sprint has stuck tasks", async () => {
    const sprint = makeDraftSprint({ name: 'Broken Sprint' });
    // Build a blocked task for this sprint.
    const blocked: Task = {
      id: 'task-b1' as never,
      name: 'stuck-one',
      status: 'blocked',
      blockedReason: 'verify timed out',
      dependsOn: [],
      attempts: [],
      ticketId: 'tkt-1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const deps = {
      sprintRepo: fakeSprintRepo([sprint]),
      taskRepo: {
        async findBySprintId() {
          return Result.ok([blocked] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintsView />, { deps, initial: { id: 'sprints' } });
    // Extra ticks: one for sprint list render, one for task fetch effect.
    await tick(80);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Broken Sprint');
    // 'u unblock (1)' should appear somewhere in the status bar hints. The terminal used by
    // ink-testing-library may wrap the label across lines — check that both "unblock" and "(1)"
    // appear in the frame (they are part of the same hint even if line-wrapped).
    expect(frame).toContain('unblock');
    expect(frame).toContain('(1)');
    result.unmount();
  });

  it('pressing u on a sprint with stuck tasks calls unblockTaskUseCase and shows feedback', async () => {
    const sprint = makeDraftSprint({ name: 'Recovery Sprint' });
    const blocked: Task = {
      id: 'task-c1' as never,
      name: 'jvm-wedge',
      status: 'blocked',
      blockedReason: 'agent attach failed',
      dependsOn: [],
      attempts: [],
      ticketId: 'tkt-2' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const updateCalls: Task[] = [];
    let stored: readonly Task[] = [blocked];

    const deps = {
      sprintRepo: fakeSprintRepo([sprint]),
      taskRepo: {
        async findBySprintId() {
          return Result.ok(stored);
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          stored = [{ ...(blocked as object), status: 'todo' } as unknown as Task];
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintsView />, { deps, initial: { id: 'sprints' } });
    // Wait for sprint list + task fetch to settle.
    await tick(80);
    result.stdin.write('u');
    // Let the sequential unblock loop + feedback + task refresh complete.
    await tick(120);
    const frame = result.lastFrame() ?? '';
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.status).toBe('todo');
    expect(frame).toMatch(/unblocked 1 task/);
    result.unmount();
  });

  it('pressing u builds a settled in_progress task back to todo (crash-recovery path)', async () => {
    const sprint = makeDraftSprint({ name: 'Crash Sprint' });
    // Build an in_progress task with an aborted (settled) attempt.
    const todo = makeTodoTask({ name: 'crashed' });
    const inProgress = (() => {
      const r = startNextAttempt(todo, IsoTimestamp.now(), 'sess-z');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      return r.value;
    })();
    const settled = (() => {
      const r = failCurrentAttempt(inProgress, IsoTimestamp.now(), 'aborted');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      if (r.value.status !== 'in_progress') throw new Error('fixture: expected in_progress after single-attempt abort');
      return r.value;
    })();

    const updateCalls: Task[] = [];
    let stored: readonly Task[] = [settled as unknown as Task];

    const deps = {
      sprintRepo: fakeSprintRepo([sprint]),
      taskRepo: {
        async findBySprintId() {
          return Result.ok(stored);
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          stored = [{ ...(settled as object), status: 'todo' } as unknown as Task];
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintsView />, { deps, initial: { id: 'sprints' } });
    await tick(80);
    result.stdin.write('u');
    await tick(120);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.status).toBe('todo');
    result.unmount();
  });

  it('renders sprints newest-first (most recently created at the top)', async () => {
    // UUIDv7 ids sort lexicographically in creation order, so 'sprint-02' is newer than
    // 'sprint-01'. The repo hands them back ascending; the view must reverse to newest-first.
    const older = makeSprint({ id: 'sprint-01', name: 'Older Sprint', slug: 'older' });
    const newer = makeSprint({ id: 'sprint-02', name: 'Newer Sprint', slug: 'newer' });
    // Pass them oldest-first, mimicking sprintRepo.list()'s ascending order.
    const { result } = renderView(<SprintsView />, { deps: stubDeps([older, newer]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Newer Sprint');
    expect(frame).toContain('Older Sprint');
    expect(frame.indexOf('Newer Sprint')).toBeLessThan(frame.indexOf('Older Sprint'));
    result.unmount();
  });

  it('renders newest-first when scoped to a project too', async () => {
    const scopedProject = 'proj' as unknown as ProjectId;
    const older = makeSprint({ id: 'sprint-01', name: 'Older Scoped', slug: 'older', projectId: 'proj' });
    const newer = makeSprint({ id: 'sprint-02', name: 'Newer Scoped', slug: 'newer', projectId: 'proj' });
    const { result } = renderView(<SprintsView />, {
      deps: stubDeps([older, newer]),
      initial: { id: 'sprints' },
      selection: { projectId: scopedProject },
    });
    await tick(80);
    const frame = result.lastFrame() ?? '';
    expect(frame.indexOf('Newer Scoped')).toBeLessThan(frame.indexOf('Older Scoped'));
    result.unmount();
  });

  it('renders a single sprint without error', async () => {
    const sprint = makeSprint({ id: 'sprint-01', name: 'Solo Sprint', slug: 'solo' });
    const { result } = renderView(<SprintsView />, { deps: stubDeps([sprint]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Solo Sprint');
    expect(frame).toContain('1 sprint(s)');
    result.unmount();
  });

  it('windows the list: a sprint past the viewport becomes visible after End focuses it', async () => {
    // Eight sprints, only 4 rows visible at once. Newest-first sort puts 'sprint-08' at the top
    // and 'sprint-01' (oldest) at the bottom — off the initial window. Pressing End focuses the
    // last item and the cursor-centred window scrolls it into view, evicting the top of the list.
    const sprints = Array.from({ length: 8 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return makeSprint({ id: `sprint-${n}`, name: `Sprint ${n}`, slug: `s-${n}` });
    });
    const { result } = renderView(<SprintsView />, { deps: stubDeps(sprints), initial: { id: 'sprints' } });
    await tick(40);
    const before = result.lastFrame() ?? '';
    // Newest (sprint-08) is at the top of the window; the oldest (sprint-01) is below the fold.
    expect(before).toContain('Sprint 08');
    expect(before).not.toContain('Sprint 01');

    result.stdin.write(END);
    await tick(40);
    const after = result.lastFrame() ?? '';
    // After End the window has scrolled to the bottom: the previously-hidden oldest sprint shows,
    // and the newest has scrolled off the top.
    expect(after).toContain('Sprint 01');
    expect(after).not.toContain('Sprint 08');
    result.unmount();
  });

  it('renders the empty state for a project with no sprints', async () => {
    const scopedProject = 'proj' as unknown as ProjectId;
    const { result } = renderView(<SprintsView />, {
      deps: stubDeps([]),
      initial: { id: 'sprints' },
      selection: { projectId: scopedProject },
    });
    await tick(80);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No sprints yet');
    result.unmount();
  });
});
