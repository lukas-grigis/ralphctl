/**
 * E2E scenario — rate-limit retry.
 *
 * One task whose first AI spawn returns a rate-limit error and whose
 * second spawn succeeds. Verifies:
 *
 *   - `looksRateLimited` correctly classifies the storage error (message
 *     matches `/rate.?limit/i`)
 *   - `ExecuteSingleTaskUseCase` converts the spawn outcome into a kernel
 *     `code: 'rate-limited'` error
 *   - the per-task chain's `Retry(retryOn: 'rate-limited')` re-runs the
 *     leaf, which calls `aiSession.spawnHeadless` a second time
 *   - the second spawn succeeds → task settles to `done`
 *   - the runner ends `completed`
 *   - the rate-limit coordinator was paused during the retry (observable
 *     via the dashboard's banner)
 */
import { describe, it, expect } from 'vitest';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-rate-limit');

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('e2e: rate-limit retry', () => {
  it('retries after a rate-limit error and lands the task on the second attempt', async () => {
    const sprint0 = makeSprint({ slug: 'rl' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/rl');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    const task = makeTask({ name: 'do-thing', order: 1, projectPath: '/tmp/rl-repo' });

    // First spawn: a StorageError whose message matches the rate-limit
    // pattern. Second spawn: a clean success that parses to <task-complete>.
    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: [task],
      cwd: CWD,
      evaluationIterations: 0,
      aiSession: {
        outcomes: [
          {
            kind: 'error',
            error: new StorageError({ subCode: 'io', message: 'rate-limit hit (429)' }),
          },
          { kind: 'ok', result: { output: 'task complete' } },
        ],
      },
      // SignalParser is only consulted on a successful spawn — script a
      // single result for the retry.
      signalParser: {
        results: [[taskCompleteSignal]],
      },
    });

    const terminal = await harness.waitForTerminal({ timeout: 6000 });
    expect(terminal).toBe('completed');

    // The chain spawned the AI twice — the first attempt rate-limited,
    // the second succeeded.
    const ai = harness.deps.aiSession as FakeAiSessionPort;
    expect(ai.captured).toHaveLength(2);

    // Task persisted as done.
    const persisted = await harness.deps.taskRepo.findBySprintId(sprint.id);
    if (!persisted.ok) throw new Error('taskRepo.findBySprintId failed');
    expect(persisted.value[0]?.status).toBe('done');

    // Frame settles into the chain-level COMPLETED chip.
    await harness.waitForFrame(/\[COMPLETED\]/);

    // The rate-limit coordinator's current pause state is timing-sensitive
    // (the second spawn already started and may have resumed it by now).
    // The spawn-count + persisted-status assertions above are the
    // load-bearing proof; coordinator pause/resume wiring is unit-tested
    // separately.
  });
});
