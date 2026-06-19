/**
 * TasksPanel — the card's eval verdict is sourced from the AUTHORITATIVE per-task map
 * (`taskEvaluationById`, built from the task entity's last attempt by the host), NOT from the
 * timestamp-bucketed `TaskBucket.evaluations` signal stream.
 *
 * The bug this guards against: under a PARALLEL/wave sprint, evaluator signals are attributed to
 * tasks by timestamp window. Windows overlap and evaluator timestamps are AI-fabricated, so a
 * `failed` EvaluationSignal from another lane (or a superseded round) can land in a passed task's
 * window and render "eval failed" on its card. Sourcing the verdict from task-id-keyed state makes
 * that impossible.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const failedSignal = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  timestamp: ts(10),
  dimensions: [
    { dimension: 'correctness', passed: false, finding: 'leaked from another lane' },
    { dimension: 'completeness', passed: true, finding: 'ok' },
  ],
});

const evalMap = (entries: Record<string, TaskEvaluation>): ReadonlyMap<string, TaskEvaluation> =>
  new Map(Object.entries(entries));

describe('TasksPanel authoritative eval verdict', () => {
  it('renders "passed" even when a leaked FAILED signal sits in the task bucket (passed never shows failed)', async () => {
    // A done/verified task that ALSO carries a `failed` EvaluationSignal in its bucketed stream
    // (a leaked cross-task / superseded-round signal). The card MUST show the authoritative pass.
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'completed',
          subSteps: [],
          evaluations: [failedSignal()],
          signals: [],
          genEvalRound: 1,
        },
      ],
      orphanSignals: [],
    };

    const r = render(
      <TasksPanel
        bucketed={bucketed}
        running={false}
        taskEvaluationById={evalMap({ 'task-1': { status: 'passed', attemptN: 1, finishedAt: ts(20) } })}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('passed');
    expect(frame).not.toMatch(/eval\s+failed/);
    // The leaked signal's per-dimension finding must not surface as a verdict either.
    expect(frame).not.toContain('leaked from another lane');
    r.unmount();
  });

  it('isolates cross-task leakage: the active task shows its own passed verdict with a failed signal bucketed to it', async () => {
    // Two tasks. A failed signal is bucket-attributed to the ACTIVE task A's window (A is the
    // first non-completed task, so its card auto-expands and renders the verdict line). A's
    // authoritative verdict is passed — the leaked failed signal must NOT surface on its card.
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-a',
          status: 'running',
          subSteps: [],
          evaluations: [failedSignal()], // leaked into A's window
          signals: [],
          genEvalRound: 1,
        },
        {
          id: 'task-b',
          status: 'completed',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 1,
        },
      ],
      orphanSignals: [],
    };

    const r = render(
      <TasksPanel
        bucketed={bucketed}
        running={true}
        nameById={
          new Map([
            ['task-a', 'task-a-name'],
            ['task-b', 'task-b-name'],
          ])
        }
        taskEvaluationById={evalMap({
          'task-a': { status: 'passed', attemptN: 1 },
        })}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    // The active task's verdict is its authoritative pass — never the leaked failed signal.
    expect(frame).toContain('passed');
    expect(frame).not.toMatch(/eval\s+failed/);
    expect(frame).not.toContain('leaked from another lane');
    r.unmount();
  });

  it('renders the malformed verdict with the warning colour token (no per-criterion glyphs)', async () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'completed',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 1,
        },
      ],
      orphanSignals: [],
    };

    const r = render(
      <TasksPanel
        bucketed={bucketed}
        running={false}
        taskEvaluationById={evalMap({ 'task-1': { status: 'malformed', attemptN: 3 } })}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('malformed');
    expect(frame).toContain('attempt 3');
    r.unmount();
  });
});
