/**
 * A task blocked on its OWN merits (budget exhausted, red post-task-verify, generator self-block)
 * traces as a clean `completed` (see `bucket-task-signals.ts`'s module docstring) — the trace alone
 * cannot tell it apart from a genuine pass. `TasksPanelHost` is the ONE production construction
 * site of `TasksPanel` (see `tasks-panel.tsx`'s `firstBlockedIdx` comment), so this pins the fix at
 * the real integration point: given a trace-`completed` bucket and a polled entity that reports
 * `blocked`, the rendered card must read `blocked` — not the green `completed` word — the run's
 * done/total surfaces (covered separately in `bucket-task-signals-blocked-own.test.ts` and
 * `execute-body-blocked-count.test.tsx`) must exclude it, and a small card budget must not window
 * it off-screen behind the LAST (merely-completed) sibling.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

// `TasksPanelHost` calls `useUnblockTask`, which needs `useDeps()` — irrelevant to what this file
// tests (status derivation, not the unblock action), so it's mocked exactly as
// `tasks-panel-host-unblock.test.tsx` mocks it.
vi.mock('@src/application/ui/tui/runtime/use-unblock-task.ts', () => ({
  useUnblockTask: () => vi.fn().mockResolvedValue({ ok: true, value: undefined }),
}));

const bucket = (id: string, status: TaskBucket['status']): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
  durationMs: 1000,
});

const makeDescriptor = (): SessionDescriptor => ({
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'completed',
  startedAt: 0,
  trace: [],
});

describe('TasksPanelHost — own-failure block renders as blocked, not completed', () => {
  it('shows the blocked glyph/status word for a task the trace alone reports completed', async () => {
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const selfBlockedResult = markTaskBlocked(
      { ...todo, id: 'task-self-blocked' as TaskId },
      'budget exhausted after 3 attempts',
      'own'
    );
    if (!selfBlockedResult.ok) throw new Error('fixture setup failed');
    const selfBlockedTask = selfBlockedResult.value;

    // The trace-derived bucket — exactly what a clean self-block subchain produces: `completed`.
    const bucketed: BucketedExecution = {
      tasks: [bucket('task-self-blocked', 'completed'), bucket('task-sibling', 'completed')],
      orphanSignals: [],
    };
    const names = new Map([
      ['task-self-blocked', 'Self-blocked task'],
      ['task-sibling', 'Sibling task'],
    ]);

    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={{ ...makeDescriptor(), taskNames: names }}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[selfBlockedTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('Self-blocked task'));
    const frame = r.lastFrame() ?? '';
    const selfBlockedLine = frame.split('\n').find((l) => l.includes('Self-blocked task'));

    // The self-blocked card's own header line must say `blocked` — never `completed` — even
    // though the trace-derived bucket it started from read `completed` for this exact task.
    // (The genuinely-completed sibling legitimately still says `completed` elsewhere in the frame.)
    expect(selfBlockedLine).toContain('blocked');
    expect(selfBlockedLine).not.toContain('completed');
    // The blocked-reason notice line renders too — not just a bare status word.
    expect(frame).toContain('budget exhausted after 3 attempts');
    r.unmount();
  });

  it('keeps the self-blocked card inside a small window instead of anchoring on the last sibling', async () => {
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const selfBlockedResult = markTaskBlocked(
      { ...todo, id: 'task-self-blocked' as TaskId },
      'budget exhausted',
      'own'
    );
    if (!selfBlockedResult.ok) throw new Error('fixture setup failed');

    // 5 tasks, self-block at index 0, everything else genuinely completed — the trace-only bucket
    // shows ALL FIVE as `completed`, so the pre-fix anchor would fall through to the LAST card.
    const bucketed: BucketedExecution = {
      tasks: [
        bucket('task-self-blocked', 'completed'),
        bucket('t-2', 'completed'),
        bucket('t-3', 'completed'),
        bucket('t-4', 'completed'),
        bucket('t-5', 'completed'),
      ],
      orphanSignals: [],
    };
    const names = new Map([
      ['task-self-blocked', 'Self-blocked task'],
      ['t-2', 'Second task'],
      ['t-3', 'Third task'],
      ['t-4', 'Fourth task'],
      ['t-5', 'Last settled task'],
    ]);

    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={{ ...makeDescriptor(), taskNames: names }}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={1}
        inputActive={true}
        now={0}
        taskState={[selfBlockedResult.value]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').length > 0);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Self-blocked task');
    expect(frame).not.toContain('Last settled task');
    r.unmount();
  });

  it('threads the generator question / what-unblocks-it fields from the entity onto the card', async () => {
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const selfBlockedResult = markTaskBlocked(
      { ...todo, id: 'task-self-blocked' as TaskId },
      'generator reported missing information',
      'own'
    );
    if (!selfBlockedResult.ok) throw new Error('fixture setup failed');
    // `markTaskBlocked` doesn't take the generator's structured triage — it's populated directly
    // on the entity, mirroring how the real settle-attempt pipeline sets it from the signal.
    const selfBlockedTask = {
      ...selfBlockedResult.value,
      question: 'Which auth provider should tickets use?',
      whatUnblocksMe: 'a decision on the provider',
    };

    const bucketed: BucketedExecution = {
      tasks: [bucket('task-self-blocked', 'completed')],
      orphanSignals: [],
    };

    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={{ ...makeDescriptor(), taskNames: new Map([['task-self-blocked', 'Self-blocked task']]) }}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[selfBlockedTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('Self-blocked task'));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Which auth provider should tickets use?');
    expect(frame).toContain('a decision on the provider');
    r.unmount();
  });
});
