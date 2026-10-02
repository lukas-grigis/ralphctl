/**
 * Sprint-detail `u` follows its own conflict toast's advice, end to end.
 *
 * When the single-active-per-project check refuses a `done` → `review` reopen, the conflict toast
 * tells the operator to run `ralphctl sprint reopen <id>` — a CLI-only command — then reload (`r`),
 * then press `u` again. `useSprintBundle` never polls, so without the `r` chord this view would
 * hold a stale `done` sprint forever after an out-of-process reopen and the second `u` would be a
 * silent no-op (the widened stuck-task gate needs `sprintStatus === 'review'` to fire). This test
 * performs the out-of-process mutation directly on the stubbed repo (standing in for the CLI
 * command running in a second terminal) and then follows the toast's own steps in THIS mounted
 * view — proving `r` actually makes `u` reachable again, not just that the copy claims it does.
 *
 * Assertions read the header card's status chip (`[DONE]` / `[REVIEW]` / `[ACTIVE]`) and the
 * task-repo / sprint-repo call log rather than the footer's local+global hint strip: that strip
 * is a pre-existing width-overflow trap once BOTH `u unblock` and `B next blocked` are live at
 * once (independent of this fix — see `keyboard-map.ts`'s note on `pickSprint` for the same
 * class of bug), so it is not a reliable signal in this scenario.
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

const sprint = (id: SprintId, name: string, status: Sprint['status']): Sprint =>
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

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: CLOSED_ID } };

/** Ink soft-wraps the toast, so assert against a whitespace-flattened frame. */
const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

describe('SprintDetailView — u after an out-of-process `ralphctl sprint reopen`', () => {
  it('is a no-op until r reloads, then finishes the reopen on a second u — matching the toast', async () => {
    const updated: Task[] = [];
    // Mutable in-memory "disk": the CLOSED sprint starts `done` next to an `active` PEER (refuses
    // the reopen), then gets mutated to `review` with no peer — standing in for the operator
    // running `ralphctl sprint reopen` in a second terminal after closing the peer.
    let onDisk: Sprint = CLOSED;
    let peers: readonly Sprint[] = [CLOSED, PEER];
    const savedSprints: Sprint[] = [];
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(onDisk);
        },
        async list() {
          return Result.ok(peers);
        },
        async save(s: Sprint) {
          savedSprints.push(s);
          onDisk = s;
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
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('wedged'));
    expect(flat(result.lastFrame() ?? '')).toContain('[DONE]');

    // Cursor starts on the ticket row; one `j` lands on the single task below it.
    result.stdin.write('j');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblocked'));

    // First `u`: task revived, sprint stays closed, conflict toast names the two-step follow-up
    // this view actually supports (reopen, then reload, then unblock again).
    const firstToast = flat(result.lastFrame() ?? '');
    expect(updated[0]?.status).toBe('todo');
    expect(onDisk.status).toBe('done');
    expect(firstToast).toContain("'ralphctl sprint reopen sprint-closed-fixture'");
    expect(firstToast).toContain('then r to reload');
    expect(firstToast).toContain('u again');

    // Out-of-process step: the operator closes the peer and runs `ralphctl sprint reopen` in a
    // second terminal. Simulated directly on the stub, since that command is CLI-only.
    onDisk = sprint(CLOSED_ID, 'Closed Sprint', 'review');
    peers = [onDisk];

    // `r` reload — the fix under test. Without it, this view keeps rendering the stale `done`
    // sprint forever (no poll). The header card's status chip is the reload's most legible tell.
    result.stdin.write('r');
    await waitForPredicate(() => flat(result.lastFrame() ?? '').includes('[REVIEW]'));

    // Second `u`, in the SAME mounted view, no navigation away and back — the already-todo
    // short-circuit persists no task write, only the sprint hop.
    result.stdin.write('u');
    await waitForPredicate(() => savedSprints.at(-1)?.status === 'active');

    const secondToast = flat(result.lastFrame() ?? '');
    expect(secondToast).toContain('sprint reopened review → active');
    expect(updated).toHaveLength(1); // no second task write — confirms the short-circuit path ran
    expect(onDisk.status).toBe('active');
    result.unmount();
  });
});
