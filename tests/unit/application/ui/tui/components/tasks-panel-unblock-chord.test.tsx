/**
 * TasksPanel — the `u` chord that revives the FOCUSED card's stuck task, and the `e` chord now
 * anchored on the FOCUSED card (with the active task only as a fallback) instead of exclusively
 * the active task — which used to go dead the instant a run settled (no active task) even while
 * the card cursor sat right on a blocked card.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { ENTER, tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const bucketed = (): BucketedExecution => ({
  tasks: [
    { id: 'task-blocked', status: 'blocked', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
    { id: 'task-live', status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 1 },
  ],
  orphanSignals: [],
});

describe('TasksPanel — u unblock chord', () => {
  it('fires onUnblock with the focused card id when it is blocked', async () => {
    const onUnblock = vi.fn<(taskId: string) => void>();
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        blockedTaskIds={new Set(['task-blocked'])}
        onUnblock={onUnblock}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Cursor defaults to the active (running) card — move up onto the blocked one first.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('u');
    await waitForPredicate(() => onUnblock.mock.calls.length === 1);

    expect(onUnblock).toHaveBeenCalledWith('task-blocked');
    r.unmount();
  });

  it('is inert on a focused card that is not in blockedTaskIds', async () => {
    const onUnblock = vi.fn<(taskId: string) => void>();
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        blockedTaskIds={new Set(['task-blocked'])}
        onUnblock={onUnblock}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Cursor stays on the active card (task-live), which is NOT in blockedTaskIds.
    r.stdin.write('u');
    await tick(50);

    expect(onUnblock).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is inert when the host wires no handler', async () => {
    const r = render(
      <TasksPanel bucketed={bucketed()} running={true} inputActive={true} blockedTaskIds={new Set(['task-blocked'])} />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Move onto the blocked card first, THEN snapshot — the move itself legitimately changes
    // the frame (cursor caret), so `before` must be captured after settling on the target card.
    r.stdin.write(UP);
    await tick(30);
    const before = r.lastFrame() ?? '';

    r.stdin.write('u');
    await tick(50);

    expect(r.lastFrame() ?? '').toBe(before);
    r.unmount();
  });
});

describe('TasksPanel — e criteria toggle anchors on the focused card', () => {
  it('expands the criteria of the card the cursor moved to, not the active task', async () => {
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        taskCriteriaById={
          new Map([
            ['task-blocked', ['Blocked-1', 'Blocked-2', 'Blocked-3', 'Blocked-4 hidden until e']],
            ['task-live', ['Live-1', 'Live-2', 'Live-3', 'Live-4 hidden until e']],
          ])
        }
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Move the card cursor off the active task onto the blocked one, expand THAT card (Enter —
    // the criteria block only renders inside an expanded card at all), then press `e`.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write(ENTER);
    await tick(30);
    r.stdin.write('e');
    await tick(40);
    const frame = r.lastFrame() ?? '';

    // The FOCUSED card's (task-blocked) 4th bullet is now visible…
    expect(frame).toContain('Blocked-4 hidden until e');
    // …while the ACTIVE card's (task-live) 4th bullet stays collapsed — proving `e` targeted the
    // focused card, not unconditionally the active one (the pre-fix behaviour).
    expect(frame).not.toContain('Live-4 hidden until e');
    r.unmount();
  });
});
