/**
 * E2E scenario — cyclic dependencies.
 *
 * Two tasks whose `blockedBy` arrays form a closed loop. Verifies:
 *
 *   - the executor's `assert-tasks-acyclic` leaf surfaces an
 *     `InvalidStateError` BEFORE any AI spawn happens
 *   - the runner ends `failed` (not `completed`)
 *   - no task transitions out of `todo` on disk
 *   - the rendered frame eventually shows a failure surface
 *
 * This pins the "cycle is a hard error, not a deadlock" contract that
 * topologicalReorder is built around.
 */
import { describe, it, expect } from 'vitest';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import type { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-cycle');

describe('e2e: cyclic dependencies', () => {
  it('surfaces a cycle as a runner failure with no AI spawns and no task transitions', async () => {
    const sprint0 = makeSprint({ slug: 'cycle' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/cycle');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    // Closed loop: A blocks B blocks A. The dependency-reorder algorithm
    // must reject this; without the assert-tasks-acyclic leaf the chain
    // would silently emit zero per-task children and proceed to mark the
    // sprint complete with no work done.
    const taskA = makeTask({ name: 'a', order: 1, projectPath: '/tmp/cycle-repo' });
    const taskB = makeTask({ name: 'b', order: 2, projectPath: '/tmp/cycle-repo', blockedBy: [taskA.id] });
    // Mutate A to depend on B by re-creating with the same id.
    const taskAWithCycle = makeTask({
      id: taskA.id,
      name: 'a',
      order: 1,
      projectPath: '/tmp/cycle-repo',
      blockedBy: [taskB.id],
    });
    const tasks: readonly Task[] = [taskAWithCycle, taskB];

    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: tasks,
      cwd: CWD,
      evaluationIterations: 0,
      // No spawn outcomes scripted — if the chain wrongly proceeds past
      // assert-tasks-acyclic, the FakeAiSessionPort's "empty success"
      // fallback would let it succeed silently. We assert on
      // `captured.length === 0` below to catch that regression directly.
    });

    const terminal = await harness.waitForTerminal({ timeout: 6000 });
    expect(terminal).toBe('failed');

    const ai = harness.deps.aiSession as FakeAiSessionPort;
    expect(ai.captured).toHaveLength(0);

    const prompts = harness.deps.prompts as FakePromptBuilderPort;
    expect(prompts.executeCalls).toHaveLength(0);

    // Both tasks remain `todo` — no transition happened.
    const persisted = await harness.deps.taskRepo.findBySprintId(sprint.id);
    if (!persisted.ok) throw new Error('taskRepo.findBySprintId failed');
    expect(persisted.value.every((t) => t.status === 'todo')).toBe(true);

    // The ExecuteView renders the failure surface — chain-level [FAILED]
    // chip plus a "Failed" result card.
    await harness.waitForFrame(/\[FAILED\]/);
  });
});
