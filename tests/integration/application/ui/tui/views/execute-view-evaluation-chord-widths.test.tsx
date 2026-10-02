/**
 * `v` (open evaluation) must work in BOTH Implement width regimes.
 *
 * `ExecuteBody` switches regime on `layout.sidebarLayout`: at ≥140 cols `ImplementLayout` renders
 * its own `TasksPanelHost` inside `ImplementMainArea`, and below that the caller's PRE-BUILT
 * `tasksPanel` node goes to `ExecuteLayout`. Only the narrow branch used to carry
 * `onOpenEvaluation` — so the chord was a silent no-op on any wide terminal while the footer kept
 * advertising `v evaluation`. Every other Execute-view test renders at ink-testing-library's
 * default 100 columns, which is exactly why that gap survived.
 *
 * The A/B here drives the same chord through both regimes with the same fixtures, so a future
 * change that reaches only one branch fails. The wide regime must also honour the same modal gate
 * (`tasksInputActive`) and the same stale-pin fallback as the narrow one.
 */

import { Box, Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { ExecuteBody, type ExecuteBodyProps } from '@src/application/ui/tui/views/execute-view-internals/body.tsx';
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
const STALE_NOTICE = 'Sprint no longer available — pick a sprint to continue.';

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

interface RenderOptions {
  readonly onOpenEvaluation: (taskId: string) => void;
  readonly tasksInputActive?: boolean;
  readonly pinnedSprintStale?: boolean;
}

/**
 * Renders `ExecuteBody` at `columns`, mirroring what `execute-view.tsx` threads: the pre-built
 * `tasksPanel` node (narrow regime, or the stale notice) AND the `onOpenEvaluation` handler (wide regime).
 */
const renderBodyAt = (
  columns: number,
  { onOpenEvaluation, tasksInputActive = true, pinnedSprintStale = false }: RenderOptions
): ChordFixture => {
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

  const tasksPanel = pinnedSprintStale ? (
    <Box>
      <Text dimColor>{STALE_NOTICE}</Text>
    </Box>
  ) : (
    <TasksPanelHost
      bucketed={bucketed}
      descriptor={descriptor}
      isRunning
      maxSignalsPerTask={layout.tasksMaxSignals}
      maxTasks={layout.tasksMaxBlocks}
      inputActive={tasksInputActive}
      now={NOW}
      taskState={taskState}
      onOpenEvaluation={onOpenEvaluation}
    />
  );

  const props: ExecuteBodyProps = {
    descriptor,
    sessionList: [],
    sessionId: SESSION_ID,
    isRunning: true,
    now: NOW,
    elapsed: '5m',
    layout,
    termColumns: columns,
    bucketed,
    executionState: undefined,
    taskState: pinnedSprintStale ? undefined : taskState,
    tokenUsage: undefined,
    tasksDone: 0,
    tasksTotal: 1,
    currentTask: undefined,
    currentTaskIdx: -1,
    currentTaskName: undefined,
    currentSubStep: undefined,
    tasksPanel,
    onOpenEvaluation,
    logEntries: [],
    cancelScopeOpen: false,
    tasksInputActive,
    attemptElapsedMs: undefined,
    remainingTaskCount: 0,
    onCancelAttempt: () => undefined,
    onCancelFlow: () => undefined,
    onDismissCancelScope: () => undefined,
    pinnedSprintStale,
    nextSteps: { steps: [], forensics: [] },
  };

  const { result } = renderView(<ExecuteBody {...props} />, {
    deps: {} as unknown as AppDeps,
    initial: { id: 'execute', props: { sessionId: SESSION_ID } },
  });

  return { taskId, result };
};

describe('ExecuteBody — `v` opens the evaluation in both width regimes', () => {
  it.each([
    { columns: 160, regime: 'wide sidebar layout (≥140 cols)' },
    { columns: 100, regime: 'narrow ExecuteLayout (<140 cols)' },
  ])('fires onOpenEvaluation at $columns cols — $regime', async ({ columns }) => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    const { taskId, result } = renderBodyAt(columns, { onOpenEvaluation });
    await waitForViewReady(result, (f) => f.includes(TASK_NAME));

    result.stdin.write('v');
    await waitForPredicate(() => onOpenEvaluation.mock.calls.length === 1, {
      label: `the \`v\` chord reached onOpenEvaluation at ${String(columns)} cols`,
    });

    expect(onOpenEvaluation).toHaveBeenCalledWith(taskId);
    result.unmount();
  });
});

describe('ExecuteBody — wide regime honours the narrow regime’s gates', () => {
  it('ignores the Tasks panel chords while an overlay or prompt is open (tasksInputActive false)', async () => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    const { result } = renderBodyAt(160, { onOpenEvaluation, tasksInputActive: false });
    await waitForViewReady(result, (f) => f.includes(TASK_NAME));

    result.stdin.write('v');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(onOpenEvaluation).not.toHaveBeenCalled();
    result.unmount();
  });

  it('shows the stale-pin notice and drops the baseline card at 160 cols', async () => {
    const { result } = renderBodyAt(160, { onOpenEvaluation: vi.fn(), pinnedSprintStale: true });
    await waitForViewReady(result, (f) => f.includes('Sprint no longer available'));

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Sprint no longer available');
    expect(frame.toLowerCase()).not.toContain('baseline');
    result.unmount();
  });
});
