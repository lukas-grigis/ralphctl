/**
 * Sprint-detail view — ticket / task list windowing (M4 regression guard).
 *
 * Before the windowed-list migration both panes rendered every row through a flat `.map()`, so
 * on a sprint with many tasks the focused card walked off the bottom of the viewport with no way
 * to follow it. These tests assert the windowing mechanism keeps the focused card inside the
 * rendered slice when the shared cursor moves past the viewport, and that overflow cues
 * (`▴ N more` / `▾ N more`) appear for the hidden rows.
 *
 * `useTerminalSize` is mocked so the per-section card budget (`sectionWindowCards(rows)`) is
 * deterministic regardless of the test stdout's default rows. At rows=24 the budget is 8 cards,
 * so a 20-task sprint must window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const sizeRef = vi.hoisted(() => ({ columns: 120, rows: 24 }));

vi.mock('@src/application/ui/tui/runtime/use-terminal-size.ts', () => ({
  useTerminalSize: (): { columns: number; rows: number } => ({ columns: sizeRef.columns, rows: sizeRef.rows }),
}));

const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const makeSprint = (overrides: Partial<Sprint>): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj-fixture' as never,
    status: 'active',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

const makeTask = (n: number): Task =>
  ({
    id: `task-${String(n)}` as never,
    name: `task-marker-${String(n)}`,
    status: 'todo',
    dependsOn: [],
    attempts: [],
    ticketId: 't1' as never,
    repositoryId: 'r1' as never,
    order: n,
    steps: [],
    verificationCriteria: [],
  }) as never;

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

describe('SprintDetailView — task-list windowing (M4 guard)', () => {
  beforeEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 24;
  });
  afterEach(() => {
    sizeRef.columns = 120;
    sizeRef.rows = 24;
  });

  it('keeps the focused task card in the rendered window when the cursor moves past the viewport', async () => {
    const TOTAL = 20;
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const tasks = Array.from({ length: TOTAL }, (_, i) => makeTask(i + 1));
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await waitForViewReady(result, (f) => f.includes('task-marker-1'));

    // Before moving, the last task is well past the rows=24 / 8-card window — it must NOT render.
    const initialFrame = result.lastFrame() ?? '';
    expect(initialFrame).not.toContain('task-marker-20');

    // Focus list = [ticket-1, task-1 … task-20]. Press 'j' enough times to land deep into the
    // task pane (cursor 19 → task-19). Each keypress moves the shared cursor down one row.
    for (let i = 0; i < 19; i++) {
      result.stdin.write('j');
      // small settle between keypresses so the windowed re-render commits

      await tick(8);
    }
    await waitFor(() => (result.lastFrame() ?? '').includes('task-marker-19'));

    const frame = result.lastFrame() ?? '';
    // The focused task (#19) must be inside the rendered window — the M4 regression would have it
    // scrolled off the bottom and absent from the frame entirely.
    expect(frame).toContain('task-marker-19');
    // An "above" overflow cue must report the hidden head rows.
    expect(frame).toMatch(/▴ \d+ more/);
    // The very first task has scrolled out of the window above.
    expect(frame).not.toContain('task-marker-1\n');
  });

  it('renders a "below" overflow cue when the focused row is at the head of a long list', async () => {
    const TOTAL = 20;
    const sprint = makeSprint({ status: 'active', tickets: [] });
    const tasks = Array.from({ length: TOTAL }, (_, i) => makeTask(i + 1));
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await waitForViewReady(result, (f) => f.includes('task-marker-1'));

    const frame = result.lastFrame() ?? '';
    // Cursor parked at the head → the tail is hidden, so a "below" cue must show the remainder.
    expect(frame).toContain('task-marker-1');
    expect(frame).toMatch(/▾ \d+ more/);
    expect(frame).not.toContain('task-marker-20');
  });

  it('does not window a short task list — every card stays visible with no overflow cues', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const tasks = [makeTask(1), makeTask(2), makeTask(3)];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await waitForViewReady(result, (f) => f.includes('task-marker-1'));

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('task-marker-1');
    expect(frame).toContain('task-marker-2');
    expect(frame).toContain('task-marker-3');
    // Below the 8-card budget → no windowing, no overflow rows.
    expect(frame).not.toMatch(/▴ \d+ more/);
    expect(frame).not.toMatch(/▾ \d+ more/);
  });
});
