/**
 * E2E scenario — evaluator fix-and-reeval loop.
 *
 * One task with `evaluationIterations: 2`. The evaluator's first round
 * returns a failing critique; the chain spawns a fix-generator round; the
 * evaluator's second round passes. Verifies:
 *
 *   - the loop runs exactly 2 evaluator rounds + 1 fix round (4 spawns
 *     total: initial execute, eval-1, fix, eval-2)
 *   - the task is persisted as `done` with `evaluationStatus: 'passed'`
 *   - the runner ends `completed`
 */
import { describe, it, expect } from 'vitest';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-eval');

const taskComplete: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

const evalFailed: HarnessSignal = {
  type: 'evaluation',
  status: 'failed',
  // A failing dimension on round 1; a different dimension on round 2 would
  // be needed to avoid plateau — but we exit the loop on round 2's PASS,
  // so the round-1 dimensions are observed only once.
  dimensions: [{ dimension: 'correctness', score: 2, passed: false, finding: 'edge case missed' }],
  overallScore: 2,
  critique: 'edge case missed',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

const evalPassed: HarnessSignal = {
  type: 'evaluation',
  status: 'passed',
  dimensions: [],
  critique: 'lgtm',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('e2e: evaluator fix-and-reeval loop', () => {
  it('runs round 1 (fail) → fix → round 2 (pass) and persists evaluationStatus = passed', async () => {
    const sprint0 = makeSprint({ slug: 'eval' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/eval');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    const task = makeTask({ name: 'do-thing', order: 1, projectPath: '/tmp/eval-repo' });

    // Spawn order:
    //   1. execute-task           → output:  task-complete
    //   2. evaluator round 1      → output:  evaluation-failed
    //   3. fix-generator (resume) → output:  task-complete
    //   4. evaluator round 2      → output:  evaluation-passed
    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: [task],
      cwd: CWD,
      evaluationIterations: 2,
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'init', sessionId: 'sess-1' } },
          { kind: 'ok', result: { output: 'eval-1' } },
          { kind: 'ok', result: { output: 'fix', sessionId: 'sess-1' } },
          { kind: 'ok', result: { output: 'eval-2' } },
        ],
      },
      signalParser: {
        results: [[taskComplete], [evalFailed], [taskComplete], [evalPassed]],
      },
    });

    const terminal = await harness.waitForTerminal({ timeout: 8000 });
    expect(terminal).toBe('completed');

    const ai = harness.deps.aiSession as FakeAiSessionPort;
    expect(ai.captured).toHaveLength(4);

    // Task ended up done with evaluationStatus = passed.
    const persisted = await harness.deps.taskRepo.findById(sprint.id, task.id);
    if (!persisted.ok) throw new Error('taskRepo.findById failed');
    expect(persisted.value.status).toBe('done');
    expect(persisted.value.evaluated).toBe(true);
    expect(persisted.value.evaluationStatus).toBe('passed');

    // Frame settles into the chain-level COMPLETED chip.
    await harness.waitForFrame(/\[COMPLETED\]/);
  });
});
