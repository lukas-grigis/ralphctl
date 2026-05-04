// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import { T0, abs, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createEvaluateFlow } from './evaluate-flow.ts';

const CWD = abs('/tmp/evaluate-test');

const passSignal: EvaluationSignal = {
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', score: 5, passed: true, finding: 'ok' },
    { dimension: 'completeness', score: 4, passed: true, finding: 'ok' },
  ],
  overallScore: 4.5,
  critique: 'lgtm',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

function activateSprint(draft: ReturnType<typeof makeSprint>) {
  const activated = draft.activate(T0);
  if (!activated.ok) throw new Error(`activateSprint: ${activated.error.message}`);
  return activated.value;
}

describe('createEvaluateFlow', () => {
  it('runs load-sprint → assert-active → load-task → check-already-evaluated → render-prompt-to-file → evaluate-task → persist-evaluation', async () => {
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'evaluator output' } }] },
      signalParser: { results: [[passSignal]] },
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-task',
      'check-already-evaluated',
      'render-prompt-to-file',
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
    // Force a real failure mid-chain by feeding load-task a missing taskId
    // so the chain aborts before evaluate-task runs.
    const sprint = activateSprint(makeSprint());
    const deps = createTestDeps({
      sprints: [sprint],
      // No tasks registered → load-task fails with NotFoundError.
      tasks: [],
    });

    // Use a synthesised TaskId that won't resolve.
    const phantom = makeTask({ name: 'phantom' });
    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: phantom.id,
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
    expect(failed?.stepName).toBe('load-task');
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and remainder "skipped"', async () => {
    const sprint = activateSprint(makeSprint());
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createEvaluateFlow(deps);

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint.id, taskId: task.id, cwd: CWD }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    // At least one trace entry must be 'aborted'.
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('short-circuits as a successful no-op when the task is already evaluated', async () => {
    // The evaluator never blocks (REQUIREMENTS.md). Re-running
    // `sprint evaluate <task>` on a task that already has a recorded
    // verdict must complete successfully, not return an error. Every
    // downstream leaf no-ops so the trace stays honest.
    const sprint = activateSprint(makeSprint());
    const task0 = makeTask({ name: 'do thing' });
    const evaluated = task0.recordEvaluation({
      status: 'passed',
      output: 'prior critique',
      file: 'evaluations/x.md',
    });

    const aiSession = new FakeAiSessionPort();
    const writeContextFile = new FakeWriteContextFilePort();
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [evaluated]]],
      overrides: { aiSession, writeContextFile },
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: evaluated.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every step in the chain still ran (as a no-op for downstream
    // leaves) so the trace remains the canonical step order.
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-task',
      'check-already-evaluated',
      'render-prompt-to-file',
      'evaluate-task',
      'persist-evaluation',
    ]);
    // The task's recorded evaluation must be untouched — re-running
    // shouldn't overwrite a prior verdict with a fresh spawn we never
    // actually performed.
    const reread = await deps.taskRepo.findById(sprint.id, evaluated.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.evaluated).toBe(true);
    expect(reread.value.evaluationStatus).toBe('passed');
    expect(reread.value.evaluationOutput).toBe('prior critique');

    // No AI spawn fired — the chain skipped evaluate-task as a no-op.
    expect(aiSession.captured).toHaveLength(0);
    // No prompt file was rendered — render-prompt-to-file honours the
    // skip flag too.
    expect(writeContextFile.writes).toHaveLength(0);
  });

  it('fails on assert-active when sprint is not active (draft)', async () => {
    // A draft sprint must be rejected by assert-active before any task
    // lookup or AI session fires. The guard is the second step in the
    // chain (index 1); no step at index 2 or beyond should run as a
    // non-skipped entry.
    const sprint = makeSprint(); // status: 'draft'
    const task = makeTask({ name: 'do thing' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createEvaluateFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      taskId: task.id,
      cwd: CWD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // assert-active is trace index 1 (load-sprint is 0).
    expect(result.error.trace[1]?.stepName).toBe('assert-active');
    expect(result.error.trace[1]?.status).toBe('failed');
    // Every step after assert-active must appear as 'skipped' — no AI
    // session or task lookup fired.
    const assertActiveIdx = result.error.trace.findIndex((t) => t.stepName === 'assert-active');
    const stepsAfter = result.error.trace.slice(assertActiveIdx + 1);
    expect(stepsAfter.every((t) => t.status === 'skipped')).toBe(true);
    // The error code must identify the state violation.
    expect(result.error.error.code).toBe('invalid-state');
  });
});
