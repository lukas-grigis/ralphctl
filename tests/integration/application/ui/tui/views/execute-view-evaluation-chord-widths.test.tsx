/**
 * `v` (open evaluation) must work in BOTH Implement width regimes.
 *
 * `ImplementLayout` is a two-branch compositor: at ≥140 cols (`layout.sidebarLayout`) it renders
 * its own `TasksPanelHost` inside `ImplementMainArea`, and below that it hands the caller's
 * PRE-BUILT `tasksPanel` node to `ExecuteLayout`. Only the narrow branch used to carry
 * `onOpenEvaluation` — so the chord was a silent no-op on any wide terminal while the footer kept
 * advertising `v evaluation`. Every other Execute-view test renders at ink-testing-library's
 * default 100 columns, which is exactly why that gap survived.
 *
 * The A/B here drives the same chord through both branches of the compositor with the same
 * fixtures, so a future change that reaches only one branch fails.
 */

import { describe, expect, it, vi } from 'vitest';
import { ImplementLayout } from '@src/application/ui/tui/views/execute-view-internals/implement-layout.tsx';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { recordRunningAttemptEvaluation, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const SESSION_ID = 'run-eval-chord';
const TASK_NAME = 'wire it';
const STARTED_AT = '2026-08-18T09:00:00.000Z' as IsoTimestamp;
const NOW = Date.parse('2026-08-18T09:05:00.000Z');
const TERM_ROWS = 40;

/** A task whose (single) attempt recorded a verdict — the gate the `v` chord checks. */
const evaluatedTask = (): Task => {
  const started = startNextAttempt(makeTodoTask({ name: TASK_NAME }), STARTED_AT, 'session-1');
  if (!started.ok) throw new Error(`fixture: ${started.error.message}`);
  const evaluated = recordRunningAttemptEvaluation(started.value, {
    status: 'failed',
    file: 'rounds/2/evaluator/evaluation.md',
  });
  if (!evaluated.ok) throw new Error(`fixture: ${evaluated.error.message}`);
  return evaluated.value;
};

interface ChordFixture {
  readonly taskId: string;
  readonly result: ReturnType<typeof renderView>['result'];
}

/**
 * Renders the compositor at `columns`, mirroring what `execute-view.tsx` threads: the pre-built
 * `tasksPanel` node (narrow branch) AND the `onOpenEvaluation` handler (wide branch).
 */
const renderChordAt = (columns: number, onOpenEvaluation: (taskId: string) => void): ChordFixture => {
  const task = evaluatedTask();
  const taskId = String(task.id);
  const taskState = [task];
  const layout = useResponsiveLayout({ columns, rows: TERM_ROWS, isRunning: true });
  const bucketed: BucketedExecution = {
    tasks: [{ id: taskId, status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 1 }],
    orphanSignals: [],
  };
  const descriptor = {
    id: SESSION_ID,
    flowId: 'implement',
    title: 'Implement — Eval chord',
    status: 'running',
    startedAt: NOW,
    trace: [],
    taskNames: new Map([[taskId, TASK_NAME]]),
  } as unknown as SessionDescriptor;

  const { result } = renderView(
    <ImplementLayout
      descriptor={descriptor}
      isRunning
      sessionId={SESSION_ID}
      termColumns={columns}
      termRows={TERM_ROWS}
      tasksPanel={
        <TasksPanelHost
          bucketed={bucketed}
          descriptor={descriptor}
          isRunning
          maxSignalsPerTask={layout.tasksMaxSignals}
          maxTasks={layout.tasksMaxBlocks}
          inputActive
          now={NOW}
          taskState={taskState}
          onOpenEvaluation={onOpenEvaluation}
        />
      }
      executionState={undefined}
      taskState={taskState}
      now={NOW}
      tokenUsage={undefined}
      pinnedSprintStale={false}
      layout={layout}
      bucketed={bucketed}
      inputActive
      onOpenEvaluation={onOpenEvaluation}
    />,
    { deps: {} as unknown as AppDeps, initial: { id: 'execute', props: { sessionId: SESSION_ID } } }
  );

  return { taskId, result };
};

describe('ImplementLayout — `v` opens the evaluation in both width regimes', () => {
  it.each([
    { columns: 160, regime: 'wide sidebar layout (≥140 cols)' },
    { columns: 100, regime: 'narrow ExecuteLayout fallback (<140 cols)' },
  ])('fires onOpenEvaluation at $columns cols — $regime', async ({ columns }) => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    const { taskId, result } = renderChordAt(columns, onOpenEvaluation);
    await waitForViewReady(result, (f) => f.includes(TASK_NAME));

    result.stdin.write('v');
    await waitForPredicate(() => onOpenEvaluation.mock.calls.length === 1, {
      label: `the \`v\` chord reached onOpenEvaluation at ${String(columns)} cols`,
    });

    expect(onOpenEvaluation).toHaveBeenCalledWith(taskId);
    result.unmount();
  });
});
