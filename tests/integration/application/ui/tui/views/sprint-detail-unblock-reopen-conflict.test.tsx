/**
 * Sprint-detail `u` on a task inside a CLOSED sprint — both outcomes of the reopen it triggers.
 *
 * Unblocking carries a `done` sprint back to `active` (`done` → `review` → `active`, see
 * `business/task/unblock-task.ts`). That is a state change the operator must see, so the toast
 * names it (`UnblockTaskOutput.sprintReopened`). When the single-active-per-project check refuses
 * the reopen instead, the task is revived but its sprint stays closed, and the use case reports
 * that on `UnblockTaskOutput.sprintReopenConflict`. The CLI prints both; this pins the TUI's half.
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

const stubDeps = (updated: Task[], sprints: readonly Sprint[] = [CLOSED, PEER]): AppDeps =>
  ({
    sprintRepo: {
      async findById(id: SprintId) {
        return Result.ok(id === PEER_ID ? PEER : CLOSED);
      },
      async list() {
        return Result.ok([...sprints]);
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
    // The conflict's hint (names the command that releases the peer) and the two-step follow-up
    // (reopen the sprint, then `u` again) must both survive — dropping either leaves the operator
    // with a task that IS revived but no way back to knowing how to make it runnable again.
    expect(frame).toContain("close sprint 'live-sprint' first");
    expect(frame).toContain("'ralphctl sprint close sprint-peer-fixture'");
    expect(frame).toContain("'ralphctl sprint reopen sprint-closed-fixture'");
    expect(frame).toContain('u again');
    result.unmount();
  });

  it('leads with the warning glyph, not the success tick', async () => {
    const updated: Task[] = [];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(updated), initial });
    await waitForViewReady(result, (f) => f.includes('wedged'));

    result.stdin.write('j');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblocked'));

    // The task IS revived but its sprint stayed closed, so the operator still has something to
    // do. A `✓` in front of "cannot reopen" reads as "all done" and is the wrong signal.
    const frame = flat(result.lastFrame() ?? '');
    expect(frame).toContain('⚠ unblocked "wedged"');
    expect(frame).not.toContain('✓ unblocked "wedged"');
    result.unmount();
  });
});

describe('SprintDetailView — u on a closed sprint that reopens', () => {
  it('says the sprint reopened, not just that the task was unblocked', async () => {
    const updated: Task[] = [];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(updated, [CLOSED]), initial });
    await waitForViewReady(result, (f) => f.includes('wedged'));

    result.stdin.write('j');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblocked'));

    const frame = flat(result.lastFrame() ?? '');
    expect(updated[0]?.status).toBe('todo');
    expect(frame).toContain('✓ unblocked "wedged" — sprint reopened done → active');
    result.unmount();
  });
});
