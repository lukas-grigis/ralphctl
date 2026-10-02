/**
 * The settled-run `u unblock` hint, asserted through a render of `ExecuteView` rather than
 * through `useExecuteInput` directly.
 *
 * `useExecuteInput` grew `hasBlockedTask` with a `false` default, and its own unit test called
 * the hook with `hasBlockedTask: true` — so the hint was green in the suite while `ExecuteView`
 * passed nothing and the hint never appeared in the shipped build. These cases pin the WIRING:
 * the flag is derived from the polled `taskState` the Tasks panel's own `u` chord resolves
 * against, so the hint strip and the handler can never disagree.
 *
 * Assertions are scoped to the hint-strip line (the one carrying `re-run`) because a settled
 * ResultCard's "Next steps" block independently prints an `unblock N blocked task(s)` row — a
 * bare `toContain('unblock')` would pass on that row alone and prove nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { makeActiveSprint, makeDoneSprint, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const SPRINT_ID = '01933fbb-4444-7000-8000-0000000000cc' as unknown as SprintId;
const PROJECT_ID = 'project-unblock-hint' as unknown as ProjectId;

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const fakeRunner = (id: string, status: RunnerStatus): Runner<unknown> =>
  ({
    id,
    status,
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const blockedTask = (name: string): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'stuck on a decision', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

const depsWithTasks = (tasks: readonly Task[], sprint: Sprint = makeReviewSprint()): AppDeps =>
  ({
    eventBus: noopEventBus,
    sprintRepo: { findById: vi.fn().mockResolvedValue({ ok: true, value: sprint }) },
    sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
    taskRepo: {
      findById: vi.fn().mockResolvedValue({ ok: false }),
      findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [...tasks] }),
    },
  }) as unknown as AppDeps;

/** The footer hint strip — identified by `re-run`, which only the settled hint set publishes. */
const hintStrip = (frame: string): string => frame.split('\n').find((line) => line.includes('re-run')) ?? '';

const renderSettled = async (sessionId: string, tasks: readonly Task[], sprint: Sprint = makeReviewSprint()) => {
  const sessions = createSessionManager();
  sessions.register({
    runner: fakeRunner(sessionId, 'completed'),
    flowId: 'implement',
    title: 'Implement — Unblock Hint',
    pinnedProjectId: PROJECT_ID,
    pinnedSprintId: SPRINT_ID,
    pinnedSprintLabel: 'Demo Sprint',
  });

  const { result } = renderView(<ExecuteView />, {
    deps: depsWithTasks(tasks, sprint),
    initial: { id: 'execute', props: { sessionId } },
    sessions,
  });
  await waitForViewReady(result, (f) => f.includes('re-run'));
  return result;
};

describe('ExecuteView — settled-run `u unblock` hint wiring', () => {
  it('publishes the hint once the polled entities report a blocked task', async () => {
    const result = await renderSettled('r-hint-blocked', [blockedTask('wire the migration')]);
    // The task poll lands a tick after the first paint — wait for the hint rather than the frame.
    await waitForPredicate(() => hintStrip(result.lastFrame() ?? '').includes('unblock'), {
      label: 'settled hint strip advertises `u unblock`',
    });

    const strip = hintStrip(result.lastFrame() ?? '');
    expect(strip).toContain('home');
    expect(strip).toContain('re-run');
    expect(strip).toContain('unblock');
    result.unmount();
  });

  it('omits the hint when no task is blocked', async () => {
    // An ACTIVE sprint so the settled card's Next-steps block prints a `taskState`-DERIVED line:
    // `run implement · 1 task pending` only exists once the poll has landed a resumable task
    // (before that the same row reads "no task is left to run"). Waiting for the strip itself
    // would settle on the first paint, where `taskState` is still undefined — i.e. the negative
    // below would pass against a build that never wires the flag at all.
    const result = await renderSettled('r-hint-clean', [makeTodoTask({ name: 'still runnable' })], makeActiveSprint());
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('task pending'), {
      label: 'the polled task list has reached the settled card',
    });

    expect(hintStrip(result.lastFrame() ?? '')).toContain('home');
    expect(hintStrip(result.lastFrame() ?? '')).not.toContain('unblock');
    result.unmount();
  });

  it('omits the hint on a DONE pin, where the panel that owns the `u` handler is gone', async () => {
    // The task poll is not gated on the availability probe, so a closed pin keeps reporting
    // blocked tasks — but `deriveTasksPanel` has already replaced the whole `TasksPanelHost`
    // (and with it `blockedTaskIds` and the `u` handler) with the pick-a-sprint notice. Hinting
    // `u` here advertises a chord nothing is listening for. Reachable on this release's own
    // path: review's auto-done settle closes the sprint at the end of the run.
    const result = await renderSettled('r-hint-done', [blockedTask('still stuck when it closed')], makeDoneSprint());
    // Anchored on a `taskState`-derived string: the done-sprint blocked callout only renders
    // once the poll has landed a blocked task, so the absence below is asserted on a frame that
    // HAS seen one.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('reopens'), {
      label: 'the settled card sees the blocked task on the closed sprint',
    });

    expect(result.lastFrame() ?? '').toContain('Sprint no longer available');
    expect(hintStrip(result.lastFrame() ?? '')).toContain('home');
    expect(hintStrip(result.lastFrame() ?? '')).not.toContain('unblock');
    result.unmount();
  });

  it('never advertises it on a LIVE run, even with a blocked task in the list', async () => {
    // The Tasks panel forces the `u` chord inert while running (`TasksPanelHost` empties
    // `blockedTaskIds` mid-run), so hinting it would advertise a key whose handler rejects
    // every press — the hint-strip invariant DESIGN-SYSTEM §6.2 forbids.
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-hint-running', 'running'),
      flowId: 'implement',
      title: 'Implement — Live',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithTasks([blockedTask('stuck mid-run')]),
      initial: { id: 'execute', props: { sessionId: 'r-hint-running' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('cancel'));

    const strip = (result.lastFrame() ?? '').split('\n').find((line) => line.includes('cancel')) ?? '';
    expect(strip).toContain('detach');
    expect(strip).not.toContain('unblock');
    result.unmount();
  });
});
