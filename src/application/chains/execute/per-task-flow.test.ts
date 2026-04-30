import { describe, expect, it } from 'vitest';

import type { HarnessSignal } from '../../../domain/signals/harness-signal.ts';
import { abs, makeSprint, makeTask } from '../../_test-fakes/fixtures.ts';
import { createTestDeps } from '../../_test-fakes/create-test-deps.ts';
import { createPerTaskFlow } from './per-task-flow.ts';

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createPerTaskFlow', () => {
  it('runs branch-preflight → mark-in-progress → execute-task → post-task-check → recover-dirty-tree → evaluate-task → mark-done', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // nested evaluate-task
        ],
      },
      signalParser: {
        results: [
          [taskCompleteSignal],
          [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [],
              critique: '',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
        ],
      },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Drop the inner Retry's `#attempt-N` decoration when checking
    // headline order.
    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    // Outer order — note retry decorates execute-task with #attempt-1.
    expect(stepNames).toContain('branch-preflight');
    expect(stepNames).toContain('mark-in-progress');
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('post-task-check');
    expect(stepNames).toContain('recover-dirty-tree');
    expect(stepNames).toContain('evaluate-task');
    expect(stepNames).toContain('mark-done');

    // Sequence assertions for the headline path.
    const idx = (n: string): number => stepNames.indexOf(n);
    expect(idx('branch-preflight')).toBeLessThan(idx('mark-in-progress'));
    expect(idx('mark-in-progress')).toBeLessThan(idx('execute-task'));
    expect(idx('execute-task')).toBeLessThan(idx('post-task-check'));
    expect(idx('post-task-check')).toBeLessThan(idx('recover-dirty-tree'));
    expect(idx('recover-dirty-tree')).toBeLessThan(idx('evaluate-task'));
    expect(idx('evaluate-task')).toBeLessThan(idx('mark-done'));

    // Task should be marked done after a successful execute-task.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
  });

  it('on branch-preflight failure: marks the task blocked, persists reason, and short-circuits the rest of the chain as no-ops', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      external: { branchOk: false, currentBranch: 'wrong-branch' },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: 'main',
    });

    // The fallback now genuinely marks the task blocked and resolves
    // successfully so the rest of the chain runs as no-ops.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    expect(stepNames).toContain('branch-preflight');
    expect(stepNames).toContain('mark-blocked');
    // Downstream leaves still emit trace entries (kept honest) — they
    // simply no-op when `taskBlocked` is set.
    expect(stepNames).toContain('mark-in-progress');
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('post-task-check');
    expect(stepNames).toContain('recover-dirty-tree');
    expect(stepNames).toContain('evaluate-task');
    expect(stepNames).toContain('mark-done');

    // Task is persisted as blocked with the preflight reason.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('blocked');
    expect(reread.value.blockedReason).toBe("Branch preflight failed: repo not on 'main'");
  });

  it('multi-round evaluator loop: failed → fix → passed records final passed status on the task', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    // iterations=3 so the loop has room to do one fix attempt.
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      evaluationIterations: 3,
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'initial' } }, // execute-task
          { kind: 'ok', result: { output: 'eval-1-failed' } }, // evaluator round 1
          { kind: 'ok', result: { output: 'fix' } }, // generator fix
          { kind: 'ok', result: { output: 'eval-2-passed' } }, // evaluator round 2
        ],
      },
      signalParser: {
        results: [
          [taskCompleteSignal], // execute-task
          [
            {
              type: 'evaluation',
              status: 'failed',
              dimensions: [{ dimension: 'safety', passed: false, finding: 'leak' }],
              critique: 'fix the leak',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
          [taskCompleteSignal], // generator fix
          [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [],
              critique: 'lgtm',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
        ],
      },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Evaluation persisted on the task entity reflects the FINAL round.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.evaluated).toBe(true);
    expect(reread.value.evaluationStatus).toBe('passed');
    // Task still flips to done once the loop returns successfully.
    expect(reread.value.status).toBe('done');
  });

  it('evaluator disabled (iterations=0): task still completes, evaluated stays false', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      evaluationIterations: 0,
      aiSession: {
        outcomes: [
          // Only one spawn: execute-task. Evaluator must not fire.
          { kind: 'ok', result: { output: 'done' } },
        ],
      },
      signalParser: { results: [[taskCompleteSignal]] },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
    // Evaluator was skipped entirely.
    expect(reread.value.evaluated).toBe(false);
    expect(reread.value.evaluationStatus).toBeUndefined();
  });

  it('leaves the task in_progress when execute-task does not complete', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // No task-complete signal — outcome will be 'failed'.
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'incomplete' } },
          { kind: 'ok', result: { output: 'evaluated' } },
        ],
      },
      signalParser: {
        results: [
          [],
          [
            {
              type: 'evaluation',
              status: 'failed',
              dimensions: [],
              critique: 'incomplete',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
        ],
      },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The chain still completes (evaluator never blocks; mark-done
    // is a no-op on non-completed outcomes).
    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    // Task remains in_progress because outcome was 'failed'.
    expect(reread.value.status).toBe('in_progress');
  });
});
