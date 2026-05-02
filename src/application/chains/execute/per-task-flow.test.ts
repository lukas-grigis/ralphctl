import { describe, expect, it } from 'vitest';

import { Result } from 'typescript-result';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { AiSessionPort, SessionResult } from '@src/business/ports/ai-session-port.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakeSignalBusPort } from '@src/business/_test-fakes/fake-signal-bus-port.ts';
import { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import { abs, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createPerTaskFlow } from './per-task-flow.ts';

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createPerTaskFlow', () => {
  it('runs branch-preflight → mark-in-progress → wait-for-rate-limit → execute-task → post-task-check → recover-dirty-tree → evaluate-task → mark-done', async () => {
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
    expect(stepNames).toContain('wait-for-rate-limit');
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('post-task-check');
    expect(stepNames).toContain('recover-dirty-tree');
    expect(stepNames).toContain('evaluate-task');
    expect(stepNames).toContain('mark-done');

    // Sequence assertions for the headline path.
    const idx = (n: string): number => stepNames.indexOf(n);
    expect(idx('branch-preflight')).toBeLessThan(idx('mark-in-progress'));
    expect(idx('mark-in-progress')).toBeLessThan(idx('wait-for-rate-limit'));
    expect(idx('wait-for-rate-limit')).toBeLessThan(idx('execute-task'));
    expect(idx('execute-task')).toBeLessThan(idx('post-task-check'));
    expect(idx('post-task-check')).toBeLessThan(idx('recover-dirty-tree'));
    expect(idx('recover-dirty-tree')).toBeLessThan(idx('evaluate-task'));
    expect(idx('evaluate-task')).toBeLessThan(idx('mark-done'));

    // Task should be marked done after a successful execute-task.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
  });

  it('emits a success-level log when a task is marked done', async () => {
    const logger = new FakeLoggerPort();
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
      overrides: { logger },
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

    const successEntry = logger.entries.find(
      (e) => e.level === 'success' && e.message.includes(String(task.id)) && e.message.includes('completed')
    );
    expect(successEntry).toBeDefined();
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

  it('on user-initiated abort during execute-task: marks task blocked with reason "cancelled by user", short-circuits the rest of the chain', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // Custom AiSession that throws an `aborted` kernel error mid-spawn —
    // mimics the abort propagated by SessionManager.kill() during AI work.
    // The thrown value carries `code: 'aborted'` so the kernel's
    // `toKernelError` recognises it as an abort. We extend Error to keep
    // the lint rule against non-Error rejections happy.
    class AbortKernelError extends Error {
      readonly code = 'aborted';
      constructor() {
        super('cancelled by user');
        this.name = 'AbortKernelError';
      }
    }
    const abortingAiSession: AiSessionPort = {
      spawnHeadless(): Promise<Result<SessionResult, DomainError>> {
        return Promise.reject(new AbortKernelError());
      },
      spawnWithRetry(): Promise<Result<SessionResult, DomainError>> {
        return Promise.reject(new AbortKernelError());
      },
      spawnInteractive(): Promise<Result<void, DomainError>> {
        return Promise.resolve(Result.error(new StorageError({ subCode: 'io', message: 'unused' })));
      },
      resumeSession(): Promise<Result<SessionResult, DomainError>> {
        return Promise.reject(new AbortKernelError());
      },
      ensureReady(): Promise<void> {
        return Promise.resolve();
      },
      getProviderName: () => 'claude',
      getProviderDisplayName: () => 'Claude',
      getSpawnEnv: () => ({}),
    };

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      overrides: { aiSession: abortingAiSession },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });

    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The chain resolves OK because mark-blocked recovers the abort.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    // execute-task ran (and aborted), then the OnError fallback's
    // mark-blocked leaf transitioned the task and short-circuited downstream.
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('mark-blocked');
    // Downstream leaves still emit trace entries (kept honest) but no-op.
    expect(stepNames).toContain('post-task-check');
    expect(stepNames).toContain('mark-done');

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('blocked');
    expect(reread.value.blockedReason).toBe('cancelled by user');
  });

  it('leaves the task in_progress when the evaluator explicitly fails', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // No task-complete signal AND evaluator returns `failed` — the
    // evaluator has caught a real regression so the task is left
    // in_progress for human review.
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
    // is a no-op when the evaluator flagged a real regression).
    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    // Task remains in_progress because the evaluator failed.
    expect(reread.value.status).toBe('in_progress');
  });

  it('marks the task done when the AI omits <task-complete> but the evaluator passes', async () => {
    // Real-world bug: agents sometimes finish the work but skip the
    // closing `<task-complete>` tag. The evaluator runs end-to-end
    // and returns `passed`, so the task is genuinely done. Without
    // this fix the chain would leave the task in_progress and
    // strand the sprint.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'incomplete' } }, // execute-task — no task-complete signal
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluator
        ],
      },
      signalParser: {
        results: [
          [], // execute-task: no task-complete → outcome 'failed'
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

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    // The evaluator endorsed the work, so the task is done even
    // without the explicit <task-complete> signal.
    expect(reread.value.status).toBe('done');
  });

  it('marks the task done when the evaluator is disabled and the AI omits <task-complete>', async () => {
    // With evaluator disabled (iterations=0) and no task-complete
    // signal, mark-done falls through to the chain's "no negative
    // signal" path. The chain has otherwise run successfully so
    // the task is treated as done.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      evaluationIterations: 0,
      aiSession: {
        outcomes: [{ kind: 'ok', result: { output: 'incomplete' } }],
      },
      signalParser: { results: [[]] }, // no task-complete
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

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
    expect(reread.value.evaluated).toBe(false);
  });

  it('wait-for-rate-limit holds off the AI spawn until the coordinator resumes', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // Pause the coordinator BEFORE the chain starts. The wait-for-rate-limit
    // leaf must await `waitUntilResumed()` and only let execute-task fire
    // after we resume.
    const coordinator = new RateLimitCoordinator();
    coordinator.pause('upstream 429');

    const ai = new FakeAiSessionPort({
      outcomes: [
        { kind: 'ok', result: { output: 'done' } }, // execute-task
        { kind: 'ok', result: { output: 'evaluated' } }, // evaluator
      ],
    });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
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
      overrides: { aiSession: ai, rateLimitCoordinator: coordinator },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const promise = flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // Yield several microtasks so wait-for-rate-limit definitely parks
    // on the coordinator. The AI session must NOT have spawned yet.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ai.captured).toHaveLength(0);

    // Resume — wait-for-rate-limit unblocks and the rest of the chain runs.
    coordinator.resume();
    const result = await promise;

    expect(result.ok).toBe(true);
    // Now execute-task has fired (one spawn for execute, one for evaluator).
    expect(ai.captured.length).toBeGreaterThanOrEqual(1);
  });

  it('use case calls coordinator.pause when the spawn surfaces a rate-limit hint', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // Two spawns to satisfy the inner Retry — both rate-limited so the
    // chain ultimately surfaces the failure. The first spawn is the one
    // that triggers `coordinator.pause(...)` from the use case.
    const rl = new StorageError({ subCode: 'io', message: 'spawn failed: 429 too many requests' });
    const ai = new FakeAiSessionPort({
      outcomes: [
        { kind: 'error', error: rl },
        { kind: 'error', error: rl },
      ],
    });

    const coordinator = new RateLimitCoordinator();

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      overrides: { aiSession: ai, rateLimitCoordinator: coordinator },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The use case should have transitioned the coordinator to paused.
    expect(coordinator.isPaused()).toBe(true);
  });

  it('use case forwards every parsed signal to the signal bus during execute-task', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    const noteSignal: HarnessSignal = {
      type: 'note',
      text: 'fyi',
      timestamp: '2026-04-29T12:00:00Z' as never,
    };
    const verifiedSignal: HarnessSignal = {
      type: 'task-verified',
      output: 'all green',
      timestamp: '2026-04-29T12:00:00Z' as never,
    };

    const bus = new FakeSignalBusPort();

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'streamed' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluator
        ],
      },
      signalParser: {
        results: [
          [noteSignal, verifiedSignal, taskCompleteSignal],
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
      overrides: { signalBus: bus },
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

    // The use case forwards each parsed signal as a `signal`-typed event
    // tagged with the sprint id and task id.
    const signalEvents = bus.events.flatMap((e) =>
      e.type === 'signal' ? [{ signalType: e.signal.type, sprintId: e.sprintId, taskId: e.taskId }] : []
    );
    const signalTypes = signalEvents.map((s) => s.signalType);
    expect(signalTypes).toContain('note');
    expect(signalTypes).toContain('task-verified');
    expect(signalTypes).toContain('task-complete');

    for (const e of signalEvents) {
      expect(e.sprintId).toBe(sprint.id);
      expect(e.taskId).toBe(task.id);
    }
  });

  it('persists status=done via taskRepo.update on the success path', async () => {
    // Explicit assertion: the success path calls taskRepo.update with
    // the transitioned (done) task — the on-disk status flips, not
    // just the in-memory entity. Belt-and-suspenders against the
    // markDoneLeaf guard regressing.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } },
          { kind: 'ok', result: { output: 'evaluated' } },
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

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
  });
});
