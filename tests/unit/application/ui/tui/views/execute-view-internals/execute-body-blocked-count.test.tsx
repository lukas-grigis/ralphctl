/**
 * `ExecuteBody`'s header/footer `tasksDone` counter must exclude a task blocked on its OWN
 * merits (budget exhausted, red verify, generator self-block) even though the trace-derived
 * bucket the orchestrator computed reads it as `completed` (see `bucket-task-signals.ts`'s module
 * docstring for why the trace alone can't tell the two apart). Without the correction this file
 * applies, a settled run with one own-failure block among N tasks shows `N/N` in
 * `inkColors.success` — the operator's headline "tasks done" readout lying green on a run that
 * did not, in fact, finish everything.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ExecuteBody, type ExecuteBodyProps } from '@src/application/ui/tui/views/execute-view-internals/body.tsx';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const LAYOUT = useResponsiveLayout({ columns: 100, rows: 40, isRunning: false });

const DESCRIPTOR: SessionDescriptor = {
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'completed',
  startedAt: 0,
  finishedAt: 5000,
  trace: [],
};

const baseProps = (bucketed: BucketedExecution, taskState: ExecuteBodyProps['taskState']): ExecuteBodyProps => ({
  descriptor: DESCRIPTOR,
  sessionList: [],
  sessionId: 'sess-1',
  isRunning: false,
  now: 5000,
  elapsed: '5s',
  layout: LAYOUT,
  termColumns: 100,
  termRows: 40,
  bucketed,
  executionState: undefined,
  taskState,
  tokenUsage: undefined,
  // Deliberately the STALE trace-only count — 2/2 — so the test fails unless `ExecuteBody`
  // recomputes it from `bucketed` + `taskState` rather than trusting this prop.
  tasksDone: 2,
  tasksTotal: 2,
  currentTask: undefined,
  currentTaskIdx: -1,
  currentTaskName: undefined,
  currentSubStep: undefined,
  tasksPanel: null,
  onOpenEvaluation: () => undefined,
  logEntries: [],
  cancelScopeOpen: false,
  attemptElapsedMs: undefined,
  remainingTaskCount: 0,
  onCancelAttempt: () => undefined,
  onCancelFlow: () => undefined,
  onDismissCancelScope: () => undefined,
  pinnedSprintStale: false,
  nextSteps: { steps: [], forensics: [] },
});

describe('ExecuteBody — tasksDone excludes an own-failure block', () => {
  it('renders 1/2, not the stale trace-only 2/2, when one task is blocked on its own merits', () => {
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const selfBlockedResult = markTaskBlocked(
      { ...todo, id: 'task-self-blocked' as TaskId },
      'budget exhausted',
      'own'
    );
    if (!selfBlockedResult.ok) throw new Error('fixture setup failed');

    const bucketed: BucketedExecution = {
      tasks: [
        { id: 'task-self-blocked', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
        { id: 'task-sibling', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
      ],
      orphanSignals: [],
    };

    const r = render(<ExecuteBody {...baseProps(bucketed, [selfBlockedResult.value])} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('1/2');
    expect(frame).not.toContain('2/2');
    r.unmount();
  });

  it('still renders the raw count when nothing is blocked (unchanged pre-existing behaviour)', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        { id: 'task-a', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
        { id: 'task-b', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
      ],
      orphanSignals: [],
    };

    const r = render(<ExecuteBody {...baseProps(bucketed, undefined)} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('2/2');
    r.unmount();
  });
});
