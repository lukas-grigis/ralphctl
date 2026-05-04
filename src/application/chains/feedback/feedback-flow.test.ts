// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import { T0, abs, makeSprint } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createFeedbackFlow } from './feedback-flow.ts';

const CWD = abs('/tmp/feedback-test');

function activateSprint(draft: ReturnType<typeof makeSprint>) {
  const activated = draft.activate(T0);
  if (!activated.ok) throw new Error(`activateSprint: ${activated.error.message}`);
  return activated.value;
}

describe('createFeedbackFlow', () => {
  it('runs load-sprint → assert-active → load-tasks → render-prompt-to-file → apply-feedback → record-feedback-iteration', async () => {
    const sprint = activateSprint(makeSprint());
    const deps = createTestDeps({
      sprints: [sprint],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'feedback applied' } }] },
    });

    const flow = createFeedbackFlow(deps);

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      feedbackText: 'please refactor X',
      iteration: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-tasks',
      'render-prompt-to-file',
      'apply-feedback',
      'record-feedback-iteration',
    ]);
  });

  it('step short-circuit: load-sprint failure (unknown sprint id) marks remaining steps as "skipped"', async () => {
    // Supply no sprints so load-sprint fails → rest skipped.
    const deps = createTestDeps({ sprints: [] });
    const unknownId = (await import('@src/application/_test-fakes/fixtures.ts')).sprintId('20260101-000000-ghost');

    const flow = createFeedbackFlow(deps);
    const result = await flow.execute({
      sprintId: unknownId,
      cwd: CWD,
      feedbackText: 'some feedback',
      iteration: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(failedIdx).toBeGreaterThan(-1);
    for (const entry of result.error.trace.slice(failedIdx + 1)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and chain fails', async () => {
    const sprint = activateSprint(makeSprint());
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createFeedbackFlow(deps);
    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint.id, cwd: CWD, feedbackText: 'text', iteration: 1 }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('still completes apply-feedback when feedback text is empty (no AI spawn)', async () => {
    const sprint = activateSprint(makeSprint());
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createFeedbackFlow(deps);
    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      feedbackText: '   ',
      iteration: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The use case short-circuits internally; the chain still walks.
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-active',
      'load-tasks',
      'render-prompt-to-file',
      'apply-feedback',
      'record-feedback-iteration',
    ]);
  });

  it('assert-active: draft sprint fails chain at assert-active, remaining steps skipped', async () => {
    const sprint = makeSprint(); // draft by default
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createFeedbackFlow(deps);
    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      feedbackText: 'some feedback',
      iteration: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace[1]?.stepName).toBe('assert-active');
    expect(result.error.trace[1]?.status).toBe('failed');
    expect(result.error.error.code).toBe('invalid-state');
    for (const entry of result.error.trace.slice(2)) {
      expect(entry.status).toBe('skipped');
    }
  });
});
