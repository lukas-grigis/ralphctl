// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import { abs, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createEvaluateFlow } from './evaluate-flow.ts';

const CWD = abs('/tmp/evaluate-test');

const passSignal: EvaluationSignal = {
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'ok' },
    { dimension: 'completeness', passed: true, finding: 'ok' },
  ],
  critique: 'lgtm',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createEvaluateFlow', () => {
  it('runs load-sprint → load-task → check-already-evaluated → evaluate-task → persist-evaluation', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'evaluator output' } }] },
      signalParser: { results: [[passSignal]] },
    });

    const flow = createEvaluateFlow(deps, {
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'load-task',
      'check-already-evaluated',
      'evaluate-task',
      'persist-evaluation',
    ]);

    // Task got the evaluation recorded.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.evaluated).toBe(true);
    expect(reread.value.evaluationStatus).toBe('passed');
  });

  it('step short-circuit: mid-chain leaf error skips remaining steps with "skipped" status', async () => {
    // check-already-evaluated returning an error should mark subsequent steps skipped.
    const sprint = makeSprint();
    const task0 = makeTask({ name: 'do thing' });
    // Mark task as already evaluated so check-already-evaluated fails.
    const evaluated = task0.recordEvaluation({
      status: 'passed',
      output: 'prior',
      file: 'evaluations/x.md',
    });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [evaluated]]],
    });

    const flow = createEvaluateFlow(deps, {
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Steps after the failing one must appear as 'skipped'.
    const skipped = result.error.trace.filter((t) => t.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    // The failing step itself is 'failed'.
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.stepName).toBe('check-already-evaluated');
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and remainder "skipped"', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createEvaluateFlow(deps, {
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    // At least one trace entry must be 'aborted'.
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('short-circuits when the task is already evaluated', async () => {
    const sprint = makeSprint();
    const task0 = makeTask({ name: 'do thing' });
    const evaluated = task0.recordEvaluation({
      status: 'passed',
      output: 'prior',
      file: 'evaluations/x.md',
    });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [evaluated]]],
    });

    const flow = createEvaluateFlow(deps, {
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('check-already-evaluated');
  });
});
