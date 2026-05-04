/**
 * E2E scenario — golden path.
 *
 * Boots the Ink TUI rooted at the ExecuteView with a 3-task sprint whose
 * tasks form a linear dependency chain (A → B → C). The scripted AI emits
 * `<task-complete>` for each spawn. Verifies:
 *
 *   - the executor linearises tasks in dependency order (A spawns first,
 *     then B, then C — never out of order)
 *   - all three tasks settle to `done` on disk
 *   - the runner reaches `completed`
 *   - the rendered frame eventually shows the success ResultCard
 *
 * This is the canonical e2e shape: real chain, real session manager, real
 * Ink rendering, scripted AI for determinism, in-memory persistence.
 */
import { describe, it, expect } from 'vitest';

import { abs, makeApprovedTicket, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import type { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { bootExecuteScenario } from './harness.tsx';

const CWD = abs('/tmp/e2e-golden');

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('e2e: golden path', () => {
  it('linearises a 3-task sprint and runs every task to done', async () => {
    // Build a sprint with one approved ticket + 3 tasks chained linearly.
    const sprint0 = makeSprint({ slug: 'golden' });
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition: addTicket');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition: activate');
    const branched = activated.value.setBranch('ralphctl/golden');
    if (!branched.ok) throw new Error('precondition: setBranch');
    const sprint = branched.value;

    // Three tasks, all in the same repo (forces the executor to honour
    // dependency order rather than fan out by repo). Tasks are intentionally
    // listed B → A → C in the input array — the executor's
    // `topologicalReorder` must defend against that ordering.
    const taskA = makeTask({ name: 'a', order: 1, projectPath: '/tmp/golden-repo' });
    const taskB = makeTask({ name: 'b', order: 2, projectPath: '/tmp/golden-repo', blockedBy: [taskA.id] });
    const taskC = makeTask({ name: 'c', order: 3, projectPath: '/tmp/golden-repo', blockedBy: [taskB.id] });
    const tasks: readonly Task[] = [taskB, taskA, taskC];

    // Script: one AI spawn per task, each parsing to <task-complete>.
    // Evaluator disabled so no extra spawns / signal-parser calls.
    const harness = bootExecuteScenario({
      sprint,
      sprintTasks: tasks,
      cwd: CWD,
      evaluationIterations: 0,
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'task-1 output' } },
          { kind: 'ok', result: { output: 'task-2 output' } },
          { kind: 'ok', result: { output: 'task-3 output' } },
        ],
      },
      signalParser: {
        results: [[taskCompleteSignal], [taskCompleteSignal], [taskCompleteSignal]],
      },
    });

    // The runner kicks off asynchronously after `start()`; wait for it
    // to reach a terminal state.
    const terminal = await harness.waitForTerminal({ timeout: 6000 });
    expect(terminal).toBe('completed');

    // Use the prompt-builder's call order as the canonical "task ran"
    // signal: the chain calls `buildExecutePrompt` exactly once per task,
    // in the order the executor processed them. The fake captures inputs
    // verbatim so we can assert names without parsing template strings.
    const prompts = harness.deps.prompts as FakePromptBuilderPort;
    expect(prompts.executeCalls).toHaveLength(3);
    const order = prompts.executeCalls.map((c) => c.task.name);
    expect(order).toStrictEqual(['a', 'b', 'c']);

    // All three tasks are persisted as done.
    const persisted = await harness.deps.taskRepo.findBySprintId(sprint.id);
    if (!persisted.ok) throw new Error('taskRepo.findBySprintId failed');
    const byName = new Map(persisted.value.map((t) => [t.name, t.status] as const));
    expect(byName.get('a')).toBe('done');
    expect(byName.get('b')).toBe('done');
    expect(byName.get('c')).toBe('done');

    // The frame settles into the chain-level COMPLETED chip plus per-task
    // [DONE] pills. We assert on the chain status — that's the stable text
    // tied to the runner's terminal state — and then poll for all three
    // task pills to land (per-task render lags the chain-status flip by
    // a render or two).
    await harness.waitForFrame(/\[COMPLETED\]/);
    await harness.waitForFrame(/\[DONE\][\s\S]*\[DONE\][\s\S]*\[DONE\]/);
  });
});
