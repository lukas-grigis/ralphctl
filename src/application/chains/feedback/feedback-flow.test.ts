// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import { abs, makeSprint } from '../../_test-fakes/fixtures.ts';
import { createTestDeps } from '../../_test-fakes/create-test-deps.ts';
import { createFeedbackFlow } from './feedback-flow.ts';

const CWD = abs('/tmp/feedback-test');

describe('createFeedbackFlow', () => {
  it('runs load-sprint → apply-feedback → check-scripts-feedback → record-feedback-iteration', async () => {
    const sprint = makeSprint();
    const deps = createTestDeps({
      sprints: [sprint],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: 'feedback applied' } }] },
    });

    const flow = createFeedbackFlow(deps, { sprintId: sprint.id, cwd: CWD });

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      feedbackText: 'please refactor X',
      iteration: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toEqual([
      'load-sprint',
      'apply-feedback',
      'check-scripts-feedback',
      'record-feedback-iteration',
    ]);
  });

  it('step short-circuit: load-sprint failure (unknown sprint id) marks remaining steps as "skipped"', async () => {
    // Supply no sprints so load-sprint fails → rest skipped.
    const deps = createTestDeps({ sprints: [] });
    const unknownId = (await import('../../_test-fakes/fixtures.ts')).sprintId('20260101-000000-ghost');

    const flow = createFeedbackFlow(deps, { sprintId: unknownId, cwd: CWD });
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
    const sprint = makeSprint();
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createFeedbackFlow(deps, { sprintId: sprint.id, cwd: CWD });
    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint.id, cwd: CWD, feedbackText: 'text', iteration: 1 }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('still completes apply-feedback when feedback text is empty (no AI spawn)', async () => {
    const sprint = makeSprint();
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createFeedbackFlow(deps, { sprintId: sprint.id, cwd: CWD });
    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      feedbackText: '   ',
      iteration: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The use case short-circuits internally; the chain still walks.
    expect(result.value.trace.map((t) => t.stepName)).toEqual([
      'load-sprint',
      'apply-feedback',
      'check-scripts-feedback',
      'record-feedback-iteration',
    ]);
  });
});
