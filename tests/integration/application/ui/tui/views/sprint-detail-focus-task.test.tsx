/**
 * Sprint-detail opened from Work's blocked-task row (`focusTaskId`): the first load seeds the
 * cursor on that task through the `B` takeover and opens its card, so the blocked reason and the
 * criteria are visible without a keypress. A missing id degrades to the ordinary first-row cursor.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const SPRINT_ID = 'sprint-focus-task-fixture' as unknown as SprintId;
const CRITERION = 'runs to completion';

const blocked = (name: string): Task => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'needs a decision', 'own');
  if (!r.ok) throw new Error('fixture setup failed');
  return r.value;
};

const FIRST = blocked('alpha stuck task');
const SECOND = blocked('omega stuck task');
const TASKS: readonly Task[] = [
  makeTodoTask({ name: 'runnable warmup' }),
  FIRST,
  makeTodoTask({ name: 'filler' }),
  SECOND,
];

const sprint = {
  id: SPRINT_ID,
  slug: 'focus-task-sprint',
  name: 'Focus Task Sprint',
  projectId: 'proj-fixture' as never,
  status: 'planned',
  tickets: [{ id: 'ticket-a', title: 'the only ticket', status: 'approved', description: 'd', requirements: 'r' }],
} as unknown as Sprint;

const deps = {
  sprintRepo: {
    async findById() {
      return Result.ok(sprint);
    },
  } as unknown as SprintRepository,
  taskRepo: {
    async findBySprintId() {
      return Result.ok([...TASKS]);
    },
  } as unknown as TaskRepository,
  projectRepo: {} as never,
  sprintExecutionRepo: {} as never,
  settingsRepo: {} as never,
  logger: noopLogger,
} as unknown as AppDeps;

const CARET = `${glyphs.actionCursor} #`;
const focusedLine = (frame: string): string => frame.split('\n').find((l) => l.includes(CARET)) ?? '';
const count = (frame: string, needle: string): number => frame.split(needle).length - 1;

const open = (focusTaskId: string | undefined) =>
  renderView(<SprintDetailView />, {
    deps,
    initial: {
      id: 'sprint-detail',
      props: { sprintId: SPRINT_ID, ...(focusTaskId !== undefined ? { focusTaskId } : {}) },
    } as ViewEntry,
  });

describe('SprintDetailView — focusTaskId', () => {
  it('focuses the named blocked task and opens only its card', async () => {
    const { result } = open(String(SECOND.id));
    await waitForViewReady(result, (f) => f.includes('omega stuck task'));
    await waitForPredicate(() => focusedLine(result.lastFrame() ?? '').includes('omega stuck task'));
    const frame = result.lastFrame() ?? '';
    expect(focusedLine(frame)).not.toContain('alpha stuck task');
    // Expanded detail (the criterion) renders for the focused card only.
    expect(count(frame, CRITERION)).toBe(1);
    expect(frame).toContain('needs a decision');
    result.unmount();
  });

  it('falls back to the ordinary cursor when the task id is unknown', async () => {
    const { result } = open('no-such-task');
    await waitForViewReady(result, (f) => f.includes('omega stuck task'));
    const frame = result.lastFrame() ?? '';
    expect(focusedLine(frame)).toContain('the only ticket');
    expect(count(frame, CRITERION)).toBe(0);
    result.unmount();
  });

  it('opens nothing when no task id is given', async () => {
    const { result } = open(undefined);
    await waitForViewReady(result, (f) => f.includes('omega stuck task'));
    expect(count(result.lastFrame() ?? '', CRITERION)).toBe(0);
    result.unmount();
  });
});
