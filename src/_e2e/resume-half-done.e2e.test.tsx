/**
 * E2E scenario — resume a half-done sprint.
 *
 * Pre-seeds a sprint with one task already in `done` state and two tasks
 * still `todo`. Verifies:
 *
 *   - the executor filters out the already-done task at construction time
 *     (no AI spawn, no per-task chain bridge)
 *   - the remaining two tasks run in dependency order
 *   - the runner reaches `completed` cleanly without deadlocking on a
 *     dependency that already settled in a prior run
 *
 * This was the failure mode that motivated `TaskCompletionCoordinator`'s
 * `preSeed` machinery in the parallel era. Under sequential execution
 * the equivalent guarantee is "filter settled tasks before bridging" —
 * this test pins that contract.
 */
import { describe, it, expect } from 'vitest';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-resume');

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('e2e: resume half-done sprint', () => {
  it('skips the already-done task and runs only the remaining two', async () => {
    const sprint0 = makeSprint({ slug: 'resume' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/resume');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    // taskA is already done from a prior run; taskB depends on taskA;
    // taskC depends on taskB. The chain must skip taskA entirely and
    // run only B and C — without deadlocking waiting on A's "completion".
    const taskA0 = makeTask({ name: 'a', order: 1, projectPath: '/tmp/resume-repo' });
    const inProgress = taskA0.markInProgress();
    if (!inProgress.ok) throw new Error('precondition: markInProgress');
    const doneRes = inProgress.value.markDone();
    if (!doneRes.ok) throw new Error('precondition: markDone');
    const taskA = doneRes.value;

    const taskB = makeTask({ name: 'b', order: 2, projectPath: '/tmp/resume-repo', blockedBy: [taskA.id] });
    const taskC = makeTask({ name: 'c', order: 3, projectPath: '/tmp/resume-repo', blockedBy: [taskB.id] });
    const tasks: readonly Task[] = [taskA, taskB, taskC];

    // Only TWO outcomes scripted — the third (taskA) must NOT spawn the AI.
    // If the chain incorrectly runs taskA, the FakeAiSessionPort will fall
    // back to its "empty success" default and the prompt-builder's
    // `executeCalls.length` will be 3 — both signals would catch the
    // regression.
    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: tasks,
      cwd: CWD,
      evaluationIterations: 0,
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'task-b output' } },
          { kind: 'ok', result: { output: 'task-c output' } },
        ],
      },
      signalParser: {
        results: [[taskCompleteSignal], [taskCompleteSignal]],
      },
    });

    const terminal = await harness.waitForTerminal({ timeout: 6000 });
    expect(terminal).toBe('completed');

    // Only B and C reached the prompt builder; A was filtered out at
    // construction time.
    const prompts = harness.deps.prompts as FakePromptBuilderPort;
    expect(prompts.executeCalls.map((c) => c.task.name)).toStrictEqual(['b', 'c']);

    // Persisted state: A stays done (untouched), B and C transitioned
    // from todo → done during this run.
    const persisted = await harness.deps.taskRepo.findBySprintId(sprint.id);
    if (!persisted.ok) throw new Error('taskRepo.findBySprintId failed');
    const byName = new Map(persisted.value.map((t) => [t.name, t.status] as const));
    expect(byName.get('a')).toBe('done');
    expect(byName.get('b')).toBe('done');
    expect(byName.get('c')).toBe('done');

    // Frame settles into the chain-level COMPLETED chip.
    await harness.waitForFrame(/\[COMPLETED\]/);
  });
});
