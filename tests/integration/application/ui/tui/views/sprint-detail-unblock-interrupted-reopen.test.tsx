/**
 * Sprint-detail `u` on a `todo` task stranded on a `review` sprint by an interrupted unblock.
 *
 * `unblockTaskUseCase`'s `review` → `active` hop runs AFTER the task write and is best-effort
 * (`business/task/unblock-task.ts`'s `activateReviewSprint`): if it fails to persist, the task is
 * already revived to `todo` but the sprint is left sitting at `review`. A retry finds an
 * already-`todo` primary and takes the `finishInterruptedReopen` short-circuit, which retries only
 * the sprint hop — no task write. Before this fix, sprint-detail's `u` gate only recognised
 * `blocked` / `in_progress` as "stuck", so a `todo` row was invisible to it and the operator had no
 * way to finish the interrupted reopen short of `ralphctl task unblock`.
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
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const REVIEW_ID = 'sprint-review-fixture' as unknown as SprintId;

const REVIEW_SPRINT = {
  id: REVIEW_ID,
  slug: 'review-sprint',
  name: 'Review Sprint',
  projectId: 'proj-fixture' as never,
  status: 'review',
  tickets: [{ id: 't1' as never, title: 'the ticket', status: 'approved' } as never],
} as unknown as Sprint;

const strandedTask = (): Task => makeTodoTask({ name: 'stranded' });

/** Ink soft-wraps the toast, so assert against a whitespace-flattened frame. */
const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

describe('SprintDetailView — u on a todo task stranded on a review sprint', () => {
  it('reaches the already-todo short-circuit and finishes the review → active hop', async () => {
    const savedSprints: Sprint[] = [];
    const updateCalls: Task[] = [];
    const stored = [strandedTask()];
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(REVIEW_SPRINT);
        },
        async list() {
          return Result.ok([REVIEW_SPRINT]);
        },
        async save(s: Sprint) {
          savedSprints.push(s);
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok(stored);
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      clock: () => IsoTimestamp.now(),
      logger: noopLogger,
    } as unknown as AppDeps;

    const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: REVIEW_ID } };
    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('stranded'));

    // Cursor starts on the ticket row; one `j` lands on the single task below it.
    result.stdin.write('j');
    // The footer hint is the gate under test — before this fix a `todo` row never sets
    // `focusedStuckTask`, so this hint never appears and `u` is a silent no-op.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblock'));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblocked'));

    const frame = flat(result.lastFrame() ?? '');
    expect(frame).toContain('unblocked "stranded" — sprint reopened review → active');
    // The already-todo short-circuit persists only the sprint hop — proving THAT path ran, not a
    // fresh blocked/in_progress → todo transition (which would also call taskRepo.update).
    expect(updateCalls).toHaveLength(0);
    expect(savedSprints).toHaveLength(1);
    expect(savedSprints[0]?.status).toBe('active');
    result.unmount();
  });
});
