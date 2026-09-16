/**
 * Sprint-detail — the `B` jump-to-next-blocked chord and the jump-mode cursor it hands over to.
 *
 * `nextBlockedIndex` (the pure helper) is covered by `sprint-detail-focus-list.test.ts`, but
 * nothing pressed the key: every guard and action of the jump block in `shortcuts.ts` reported
 * zero coverage, so a swallowed uppercase `B` (lowercase `b` is the GLOBAL banner toggle), a
 * broken `jump.available` guard, or a regression in the `useListWindow` pause handoff would all
 * ship green. These cases press it.
 *
 * Fixture shape is deliberate: two blocked tasks separated by non-blocked rows, with a ticket row
 * ahead of both, so a landing can only be explained by the jump and not by ordinary cursor drift.
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
import { END, HOME, PAGE_DOWN, PAGE_UP, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-blocked-jump-fixture' as unknown as SprintId;

const FIRST_BLOCKED = 'alpha stuck task';
const SECOND_BLOCKED = 'omega stuck task';
const BEFORE_FIRST = 'runnable warmup';
/** Row 6 (last) and row 0 (first) of the flat focus list — the paging / edge targets. */
const LAST_TASK = 'tail task';
const ONLY_TICKET = 'the only ticket';

const blocked = (name: string): Task => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'needs a decision', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

/**
 * Flat focus list, top to bottom:
 *   0 ticket · 1 runnable warmup · 2 ALPHA · 3 filler one · 4 filler two · 5 OMEGA · 6 tail task
 */
const tasks = (): readonly Task[] => [
  makeTodoTask({ name: BEFORE_FIRST }),
  blocked(FIRST_BLOCKED),
  makeTodoTask({ name: 'filler one' }),
  makeTodoTask({ name: 'filler two' }),
  blocked(SECOND_BLOCKED),
  makeTodoTask({ name: LAST_TASK }),
];

const makeSprint = (): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'blocked-jump-sprint',
    name: 'Blocked Jump Sprint',
    projectId: 'proj-fixture' as never,
    status: 'planned',
    tickets: [
      {
        id: 'ticket-a',
        title: ONLY_TICKET,
        status: 'approved',
        description: 'ticket description',
        requirements: 'requirements for the only ticket',
      },
    ],
  }) as unknown as Sprint;

const stubDeps = (): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(makeSprint());
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks()]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

/**
 * The one card row carrying the cursor caret. `ListCard` renders it as `▸ #N Title`, so anchoring
 * on `caret + ' #'` keeps this off any other `actionCursor` the page paints (action bar, hints).
 */
const CARET = `${glyphs.actionCursor} #`;
const focusedCardLine = (frame: string): string => frame.split('\n').find((line) => line.includes(CARET)) ?? '';

describe('SprintDetailView — B jumps to the next blocked task', () => {
  it('lands on each blocked row in turn and wraps back to the first', async () => {
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(), initial });
    await waitForViewReady(result, (f) => f.includes(SECOND_BLOCKED));

    // The cursor starts on the ticket row — neither blocked task is focused yet.
    expect(focusedCardLine(result.lastFrame() ?? '')).not.toContain(FIRST_BLOCKED);

    // First press: past the ticket row AND past a runnable task, straight onto the first blocked.
    result.stdin.write('B');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(FIRST_BLOCKED), {
      label: 'first B lands on the first blocked task',
    });
    expect(focusedCardLine(result.lastFrame() ?? '')).not.toContain(SECOND_BLOCKED);

    // Second press: over the two filler rows onto the second blocked task.
    result.stdin.write('B');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(SECOND_BLOCKED), {
      label: 'second B lands on the second blocked task',
    });

    // Third press wraps — the search is modulo the whole list, so it returns to the first.
    result.stdin.write('B');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(FIRST_BLOCKED), {
      label: 'third B wraps back to the first blocked task',
    });

    result.unmount();
  });

  it('hands the arrow keys to jump-mode movement once a jump has engaged', async () => {
    // `useListWindow`'s own cursor is PAUSED (not unmounted) the moment the override engages, so
    // `k` must move by exactly one row from the jumped-to index — proving the two cursors are not
    // both handling the press.
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(), initial });
    await waitForViewReady(result, (f) => f.includes(FIRST_BLOCKED));

    result.stdin.write('B');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(FIRST_BLOCKED), {
      label: 'B lands on the first blocked task',
    });

    result.stdin.write('k');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(BEFORE_FIRST), {
      label: 'k steps one row back from the jumped-to task',
    });

    result.stdin.write('j');
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(FIRST_BLOCKED), {
      label: 'j steps forward onto the blocked task again',
    });

    // The paging + edge keys are the other four jump-mode rows. `jump.pageSize` is the focus
    // window (≥8 rows) and this fixture is 7 rows deep, so a page IS an edge here — the point of
    // these presses is that the jump-mode handler claims them at all: before the override
    // engaged they belonged to `useListWindow`, which is now paused and would move nothing.
    result.stdin.write(PAGE_DOWN);
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(LAST_TASK), {
      label: 'PgDn pages to the end of the flat focus list',
    });

    result.stdin.write(PAGE_UP);
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(ONLY_TICKET), {
      label: 'PgUp pages back to the ticket row at the top',
    });

    result.stdin.write(END);
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(LAST_TASK), {
      label: 'End jumps to the last row',
    });

    result.stdin.write(HOME);
    await waitForPredicate(() => focusedCardLine(result.lastFrame() ?? '').includes(ONLY_TICKET), {
      label: 'Home jumps back to the first row',
    });

    result.unmount();
  });

  it('stays inert when nothing is blocked', async () => {
    const clean = [makeTodoTask({ name: BEFORE_FIRST }), makeTodoTask({ name: 'filler one' })];
    const deps = {
      ...stubDeps(),
      taskRepo: {
        async findBySprintId() {
          return Result.ok([...clean]);
        },
      } as unknown as TaskRepository,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('filler one'));

    const before = focusedCardLine(result.lastFrame() ?? '');
    expect(before).toContain(ONLY_TICKET);

    // Absence of change, so a bounded settle rather than a poll — a poll on "still equal" is
    // satisfied instantly and would pass before a would-be jump had a chance to land.
    result.stdin.write('B');
    await tick(50);

    expect(focusedCardLine(result.lastFrame() ?? '')).toBe(before);
    result.unmount();
  });
});
