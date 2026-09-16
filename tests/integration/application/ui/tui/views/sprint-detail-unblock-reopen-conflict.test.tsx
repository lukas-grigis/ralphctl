/**
 * Sprint-detail `u` on a task inside a CLOSED sprint, when the reopen is refused.
 *
 * Unblocking normally carries a `done` sprint back to `active` (`done` → `review` → `active`, see
 * `business/task/unblock-task.ts`), so the plain `✓ unblocked "…"` toast reads as "this task can
 * run again". It can't when the single-active-per-project check refuses the reopen: the task is
 * revived but its sprint stays closed, and the use case reports that on
 * `UnblockTaskOutput.sprintReopenConflict`. The CLI already prints it as a `note:` line; this
 * pins the TUI's half, which used to drop it on the floor.
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
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const CLOSED_ID = 'sprint-closed-fixture' as unknown as SprintId;
const PEER_ID = 'sprint-peer-fixture' as unknown as SprintId;

const sprint = (id: SprintId, name: string, status: string): Sprint =>
  ({
    id,
    slug: name.toLowerCase().replaceAll(' ', '-'),
    name,
    projectId: 'proj-fixture' as never,
    status,
    tickets: [{ id: 't1' as never, title: 'the ticket', status: 'approved' } as never],
  }) as unknown as Sprint;

const CLOSED = sprint(CLOSED_ID, 'Closed Sprint', 'done');
const PEER = sprint(PEER_ID, 'Live Sprint', 'active');

const blockedTask = (): Task => {
  const r = markTaskBlocked(makeTodoTask({ name: 'wedged' }), 'mvn agent attach failed', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

const stubDeps = (updated: Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById(id: SprintId) {
        return Result.ok(id === PEER_ID ? PEER : CLOSED);
      },
      async list() {
        return Result.ok([CLOSED, PEER]);
      },
      async save() {
        return Result.ok(undefined);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok(updated.length > 0 ? [...updated] : [blockedTask()]);
      },
      async update(_sprintId: SprintId, task: Task) {
        updated.push(task);
        return Result.ok(undefined);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    clock: () => IsoTimestamp.now(),
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: CLOSED_ID } };

/** Ink soft-wraps the toast, so assert against a whitespace-flattened frame. */
const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

describe('SprintDetailView — u on a closed sprint whose reopen is refused', () => {
  it('says the task was unblocked AND why the sprint stayed closed', async () => {
    const updated: Task[] = [];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(updated), initial });
    await waitForViewReady(result, (f) => f.includes('wedged'));

    // Cursor starts on the ticket row; one `j` lands on the single task below it.
    result.stdin.write('j');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblocked'));

    const frame = flat(result.lastFrame() ?? '');
    expect(updated[0]?.status).toBe('todo');
    expect(frame).toContain('unblocked "wedged"');
    expect(frame).toContain('cannot reopen sprint');
    expect(frame).toContain("sprint 'live-sprint' is already active in this project");
    result.unmount();
  });
});
