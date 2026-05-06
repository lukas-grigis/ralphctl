import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import type { AiSessionPort, SessionResult } from '@src/business/ports/ai-session-port.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalBusPort } from '@src/business/_test-fakes/fake-signal-bus-port.ts';
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';
import { abs, makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createPerTaskFlow } from './per-task-flow.ts';

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createPerTaskFlow', () => {
  it('runs branch-preflight → mark-in-progress → render-prompt-to-file → execute-task → post-task-check → evaluate-task → mark-done', async () => {
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
      tasks: [task],
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
    expect(stepNames).toContain('render-prompt-to-file');
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('post-task-check');
    // build-execution-unit lays down the per-task contract pack
    // (refined requirements, full task plan, dimensions, prior
    // evaluations) immediately before the evaluator round runs.
    expect(stepNames).toContain('build-execution-unit');
    expect(stepNames).toContain('evaluate-task');
    expect(stepNames).toContain('commit-task');
    expect(stepNames).toContain('mark-done');
    // recover-dirty-tree is intentionally absent — auto-committing leftover
    // changes hid them from the evaluator's `git status` check, which now
    // catches them as a Completeness failure instead.
    expect(stepNames).not.toContain('recover-dirty-tree');
    // wait-for-dependencies and wait-for-rate-limit are gone — sequential
    // execution makes both unnecessary (no siblings to gate against).
    expect(stepNames).not.toContain('wait-for-dependencies');
    expect(stepNames).not.toContain('wait-for-rate-limit');

    // Sequence assertions for the headline path.
    // Staged validation gates: cheap post-task-check runs before the expensive
    // AI evaluator (Anthropic harness-design pattern). Reordering this fence
    // is a contract change — update the trace assertion deliberately.
    const idx = (n: string): number => stepNames.indexOf(n);
    expect(idx('branch-preflight')).toBeLessThan(idx('mark-in-progress'));
    expect(idx('mark-in-progress')).toBeLessThan(idx('render-prompt-to-file'));
    expect(idx('render-prompt-to-file')).toBeLessThan(idx('build-execution-unit'));
    // build-execution-unit MUST run BEFORE execute-task so the initial
    // generator's `session.md` audit lands in `rounds/1/generator/`.
    // Reordering this is a contract change — the round-aware audit
    // layout depends on it.
    expect(idx('build-execution-unit')).toBeLessThan(idx('execute-task'));
    expect(idx('execute-task')).toBeLessThan(idx('post-task-check'));
    expect(idx('post-task-check')).toBeLessThan(idx('evaluate-task'));
    // commit-task sits AFTER the evaluator (so the evaluator's git status
    // sees the dirty tree as designed) and BEFORE mark-done.
    expect(idx('evaluate-task')).toBeLessThan(idx('commit-task'));
    expect(idx('commit-task')).toBeLessThan(idx('mark-done'));

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
      tasks: [task],
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
      tasks: [task],
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
    expect(stepNames).toContain('render-prompt-to-file');
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('post-task-check');
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
              dimensions: [{ dimension: 'safety', score: 2 as const, passed: false, finding: 'leak' }],
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
      tasks: [task],
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
      tasks: [task],
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

  it('post-task check fails (red script): inner OnError marks task blocked, downstream leaves no-op', async () => {
    // The post-task gate is wrapped in two nested OnError decorators.
    // The inner one catches `code: 'check-failed'` (the loud signal the
    // PostTaskCheckUseCase now surfaces on a red exit) and runs the
    // mark-blocked-check fallback. Downstream leaves still emit trace
    // entries (kept honest) but no-op via `taskBlocked: true` — the
    // task does NOT advance to `done`.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    // checkScriptOutcomes: first run fails — that's the post-task gate.
    const external = new FakeExternalPort({
      checkScriptOutcomes: [{ passed: false, output: '3 tests failing' }],
    });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluator (no-op when blocked)
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
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
      checkScript: 'pnpm test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    expect(stepNames).toContain('post-task-check');
    // Inner OnError fallback fired.
    expect(stepNames).toContain('mark-blocked-check');
    // Outer (soft) noop must NOT fire — the inner wrap absorbed the error.
    expect(stepNames).not.toContain('post-task-check-noop');
    // Downstream leaves still emit trace entries (no-op via taskBlocked).
    expect(stepNames).toContain('evaluate-task');
    expect(stepNames).toContain('mark-done');

    // Task is persisted as blocked with the post-task reason.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('blocked');
    expect(reread.value.blockedReason).toBe('post-task check failed');
  });

  it('post-task check spawn error (e.g. ENOENT): outer OnError swallows, task still completes', async () => {
    // A spawn-level failure (missing binary, EPERM, …) surfaces from
    // the ExternalPort as a thrown exception. The outer (soft) OnError
    // wrap catches anything except `aborted` / `check-failed`, so the
    // task still proceeds to `mark-done`. This preserves the
    // "transient environment hiccup shouldn't strand a task" semantics
    // while keeping `check-failed` a genuine block.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // Custom external that throws ENOENT from runCheckScript — mimics
    // the script binary missing or unreadable.
    const baseExternal = new FakeExternalPort();
    const throwingExternal = new Proxy(baseExternal, {
      get(target, prop, receiver) {
        if (prop === 'runCheckScript') {
          return (): Promise<never> => Promise.reject(new Error('ENOENT: no such file or directory'));
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluator
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
      overrides: { external: throwingExternal },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
      checkScript: 'pnpm test',
    });

    // Chain still resolves OK — spawn error swallowed by outer wrap.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    expect(stepNames).toContain('post-task-check');
    // Outer noop fired; inner block fallback did NOT (no `check-failed` to catch).
    expect(stepNames).toContain('post-task-check-noop');
    expect(stepNames).not.toContain('mark-blocked-check');
    expect(stepNames).toContain('mark-done');

    // Task still flips to done — the spawn error didn't gate completion.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The chain resolves OK because mark-blocked recovers the abort.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    // execute-task ran (and aborted), then the OnError fallback's
    // mark-cancelled leaf transitioned the task and short-circuited downstream.
    expect(stepNames).toContain('execute-task');
    expect(stepNames).toContain('mark-cancelled');
    // Downstream leaves still emit trace entries (kept honest) but no-op.
    expect(stepNames).toContain('post-task-check');
    expect(stepNames).toContain('mark-done');

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('blocked');
    expect(reread.value.blockedReason).toBe('cancelled by user');
  });

  it('on user abort during the evaluator round: propagates `aborted`, does NOT mark the task done', async () => {
    // Regression: the evaluator-leaf OnError used to catch ALL errors, so a
    // Ctrl+C / SessionManager.kill mid-evaluator silently fell through to
    // mark-done and the task was reported complete despite the user
    // cancelling it. The catchIf must exclude `code: 'aborted'`.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    class AbortKernelError extends Error {
      readonly code = 'aborted';
      constructor() {
        super('cancelled by user');
        this.name = 'AbortKernelError';
      }
    }
    // Generator succeeds; evaluator's spawn aborts.
    let spawnCount = 0;
    const partiallyAbortingAi: AiSessionPort = {
      spawnHeadless(): Promise<Result<SessionResult, DomainError>> {
        spawnCount += 1;
        if (spawnCount === 1) {
          return Promise.resolve(Result.ok({ output: 'generator-done' }));
        }
        return Promise.reject(new AbortKernelError());
      },
      spawnWithRetry(): Promise<Result<SessionResult, DomainError>> {
        spawnCount += 1;
        if (spawnCount === 1) {
          return Promise.resolve(Result.ok({ output: 'generator-done' }));
        }
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
      overrides: { aiSession: partiallyAbortingAi },
      signalParser: { results: [[taskCompleteSignal]] },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // Chain returns an aborted error — NOT Result.ok — because the
    // evaluator's catchIf no longer swallows `aborted`.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');

    // Task did NOT advance to done (mark-done never ran).
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).not.toBe('done');
  });

  it('marks the task done even when the evaluator explicitly fails — preserves evaluationStatus', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    // No task-complete signal AND evaluator returns `failed`. commit-task
    // and mark-done always run; the evaluation verdict is preserved on
    // the entity for the feedback loop to consume.
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The chain completes; commit-task and mark-done always run.
    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    // Task is marked done; evaluationStatus preserved for feedback loop.
    expect(reread.value.status).toBe('done');
    expect(reread.value.evaluationStatus).toBe('failed');
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
      tasks: [task],
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
    expect(reread.value.evaluated).toBe(false);
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // The use case should have transitioned the coordinator to paused.
    expect(coordinator.isPaused()).toBe(true);
  });

  it('retry preserves the initial generator audit at session.md and routes the retry to session-attempt-2.md', async () => {
    // The Retry(maxAttempts: 2, retryOn: 'rate-limited') decorator
    // re-invokes execute-task on the same leaf instance. Without a
    // per-leaf attempt counter the second attempt would overwrite
    // `rounds/1/generator/session.md` and lose the first attempt's
    // audit body. The fix keeps attempt 1 at the documented filename
    // and routes attempt 2 to `session-attempt-2.md`.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });

    const rl = new StorageError({ subCode: 'io', message: 'spawn failed: 429 too many requests' });
    const ai = new FakeAiSessionPort({
      outcomes: [
        // Attempt 1: rate-limited spawn → use case classifies as
        // 'rate-limited' → execute-task converts to a kernel error →
        // Retry fires another attempt.
        { kind: 'error', error: rl },
        // Attempt 2: ok, signals carry task-complete so the chain
        // proceeds.
        { kind: 'ok', result: { output: 'done' } },
        // Evaluator spawn (post-task-check passes by default).
        { kind: 'ok', result: { output: 'evaluated' } },
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
      overrides: { aiSession: ai },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);

    // Spawns 1 + 2 are the generator (attempt 1 then retry); spawn 3 is
    // the evaluator. The audit paths must point to the round-1 generator
    // folder, with attempt 1 keeping the bare `session.md` filename and
    // attempt 2 routed to `session-attempt-2.md`.
    expect(ai.captured.length).toBeGreaterThanOrEqual(2);
    const path1 = String(ai.captured[0]?.options.sessionMdPath ?? '');
    const path2 = String(ai.captured[1]?.options.sessionMdPath ?? '');
    expect(path1).toMatch(/\/rounds\/1\/generator\/session\.md$/);
    expect(path2).toMatch(/\/rounds\/1\/generator\/session-attempt-2\.md$/);
    expect(path1).not.toBe(path2);
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
      tasks: [task],
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

  it('render-prompt-to-file: writes the rendered execute prompt under contexts/execute-<task-id>.md', async () => {
    // The render-prompt-to-file leaf calls prompts.buildExecutePrompt
    // (which substitutes the full task body inline) and writes the
    // result to disk. The downstream execute-task leaf then hands the
    // AI a thin wrapper pointing at that file.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const writer = new FakeWriteContextFilePort();
    const prompts = new FakePromptBuilderPort();
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
      overrides: { writeContextFile: writer, prompts },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });
    expect(result.ok).toBe(true);

    // The write went to a path under sprintDir/execution/<unit-slug>/prompt.md.
    expect(writer.writes.length).toBeGreaterThanOrEqual(1);
    const written = writer.writes[0];
    expect(written?.path).toMatch(/\/execution\/[^/]+\/prompt\.md$/);

    // The prompt builder was called with the task + sprint — the rendered
    // prompt was written to disk. The execute-task leaf hands the AI a
    // thin wrapper pointing at that file (the prompt is the file body).
    expect(prompts.executeCalls).toHaveLength(1);
    expect(prompts.executeCalls[0]?.task.id).toBe(task.id);
  });

  it('render-prompt-to-file: skips writing when the task was already marked blocked upstream', async () => {
    // Branch preflight failure must short-circuit every downstream
    // leaf — including write-task-context. A blocked task has nothing
    // to execute, so writing a context file is wasted IO.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const writer = new FakeWriteContextFilePort();
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      external: { branchOk: false, currentBranch: 'wrong-branch' },
      overrides: { writeContextFile: writer },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: 'main',
    });
    expect(result.ok).toBe(true);

    // No writes — the task was blocked at preflight.
    expect(writer.writes).toHaveLength(0);
  });

  it('build-execution-unit failure absorbed by OnError, task continues to mark-done', async () => {
    // build-execution-unit has its own OnError wrap so a builder failure
    // (disk full, EPERM, ...) does NOT gate task completion — the task
    // still proceeds to `done`. The evaluator runs without an
    // executionUnitRoot in ctx (no unit was materialised), which is the
    // standalone-evaluate fallback path.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const failure = new StorageError({ subCode: 'io', message: 'no disk space' });
    const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ failWith: failure });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluator (no unit, no addDirs)
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
      overrides: { sessionFolderBuilder },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    // Chain still resolves OK — workspace failure is swallowed.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    // The OnError fallback's noop step records the swallowed failure.
    expect(stepNames).toContain('build-execution-unit');
    expect(stepNames).toContain('build-execution-unit-noop');
    expect(stepNames).toContain('mark-done');

    // Task is done despite the workspace build failure.
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
  });

  it('Copilot path: evaluator cwd is the workspace root (mirror lives there)', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        providerName: 'copilot',
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task (cwd = task.projectPath)
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluate-task (cwd = workspace root on Copilot)
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);

    // The fake folder builder returns root = `/tmp/ralphctl-fake-
    // units/<sprint-id>/execution/<unit-slug>`. The Copilot path uses
    // that as the evaluator session cwd. The generator's cwd is
    // unaffected.
    const ai = deps.aiSession as FakeAiSessionPort;
    const generatorCwd = String(ai.captured[0]?.options.cwd);
    const evaluatorCwd = String(ai.captured[1]?.options.cwd);
    expect(generatorCwd).toBe('/tmp/demo-repo');
    expect(evaluatorCwd).toContain('/execution/');
    // Copilot's evaluator does NOT receive --add-dir args (no equivalent flag).
    expect(ai.captured[1]?.options.args).toBeUndefined();
  });

  it('Claude path: evaluator receives the workspace root via --add-dir', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        providerName: 'claude',
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluate-task
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);

    const ai = deps.aiSession as FakeAiSessionPort;
    // The generator runs in the real repo with no --add-dir (it does not
    // need the workspace).
    expect(String(ai.captured[0]?.options.cwd)).toBe('/tmp/demo-repo');
    expect(ai.captured[0]?.options.args).toBeUndefined();
    // The evaluator runs in the real repo too (Claude does read-only
    // checks against the actual code) but with a --add-dir flag exposing
    // the per-execution-unit contract pack.
    expect(String(ai.captured[1]?.options.cwd)).toBe('/tmp/demo-repo');
    expect(ai.captured[1]?.options.args).toBeDefined();
    expect(ai.captured[1]?.options.args?.[0]).toBe('--add-dir');
    expect(ai.captured[1]?.options.args?.[1]).toContain('/execution/');
  });

  it('refreshExecutionUnit called once per evaluator round (multi-round loop)', async () => {
    // The per-task chain wires `refreshWorkspace` so each evaluator
    // round picks up the freshest sibling state.
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      evaluationIterations: 3,
      overrides: { sessionFolderBuilder },
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
          [taskCompleteSignal],
          [
            {
              type: 'evaluation',
              status: 'failed',
              dimensions: [{ dimension: 'safety', score: 2 as const, passed: false, finding: 'leak' }],
              critique: 'fix the leak',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
          [taskCompleteSignal],
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    // Two evaluator rounds → two refresh calls. The initial
    // `buildExecutionUnit` ran ONCE before the loop.
    expect(sessionFolderBuilder.executionCalls).toHaveLength(1);
    expect(sessionFolderBuilder.refreshCalls).toHaveLength(2);
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
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });
    expect(result.ok).toBe(true);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
  });

  it('commit-task: commits the dirty tree and persists the SHA on the task entity', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do the thing', projectPath: '/tmp/demo-repo' });
    const external = new FakeExternalPort({ uncommitted: true });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'done' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluate-task
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
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Trace contains commit-task between evaluate-task and mark-done.
    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    expect(stepNames).toContain('commit-task');
    const idx = (n: string): number => stepNames.indexOf(n);
    expect(idx('evaluate-task')).toBeLessThan(idx('commit-task'));
    expect(idx('commit-task')).toBeLessThan(idx('mark-done'));

    // commitChanges was invoked once with the formatted message.
    expect(external.commitChangesCalls).toHaveLength(1);
    const call = external.commitChangesCalls[0];
    expect(call?.message).toMatch(/^task\([0-9a-f]{1,8}\): do the thing$/);

    // SHA persisted on the task aggregate (default fake SHA = `fakecommit0001`).
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.commitSha).toBe('fakecommit0001');
    expect(reread.value.status).toBe('done');
  });

  it('commit-task: skips when the task was blocked upstream (preflight failure → no commit)', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const external = new FakeExternalPort({
      branchOk: false,
      currentBranch: 'wrong-branch',
      uncommitted: true,
    });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: 'main',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Leaf still ran (trace stays honest) but no commit fired.
    const stepNames = result.value.trace.map((t) => t.stepName.replace(/#attempt-\d+$/, ''));
    expect(stepNames).toContain('commit-task');
    expect(external.commitChangesCalls).toHaveLength(0);

    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('blocked');
    expect(reread.value.commitSha).toBeUndefined();
  });

  it('commit-task: commits even when the evaluator flagged a failed regression — evaluation verdict preserved', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const external = new FakeExternalPort({ uncommitted: true });
    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: { output: 'incomplete' } }, // execute-task
          { kind: 'ok', result: { output: 'evaluated' } }, // evaluate-task
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
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });
    expect(result.ok).toBe(true);

    // commit-task always runs now; evaluator verdict is preserved on the entity.
    expect(external.commitChangesCalls).toHaveLength(1);
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.status).toBe('done');
    expect(reread.value.evaluationStatus).toBe('failed');
  });

  it('commit-task: skips when noCommit: true is set on the per-task ctx', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const external = new FakeExternalPort({ uncommitted: true });
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
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
      noCommit: true,
    });
    expect(result.ok).toBe(true);

    expect(external.commitChangesCalls).toHaveLength(0);
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.commitSha).toBeUndefined();
    expect(reread.value.status).toBe('done');
  });

  it('commit-task: skips when the working tree is clean (no commit, no SHA)', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    // Default `uncommitted: false` — clean tree.
    const external = new FakeExternalPort();
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
      overrides: { external },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });
    expect(result.ok).toBe(true);

    expect(external.commitChangesCalls).toHaveLength(0);
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.commitSha).toBeUndefined();
    expect(reread.value.status).toBe('done');
  });

  it('commit-task: commit failure does not abort the chain — mark-done still runs', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do thing', projectPath: '/tmp/demo-repo' });
    const external = new FakeExternalPort({
      uncommitted: true,
      commitChangesOutcomes: [Result.error(new StorageError({ subCode: 'io', message: 'please tell me who you are' }))],
    });
    const logger = new FakeLoggerPort();
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
      overrides: { external, logger },
    });

    const flow = createPerTaskFlow(deps, { task, sprint });
    const result = await flow.execute({
      sprintId: sprint.id,
      sprint,
      task,
      tasks: [task],
      cwd: abs('/tmp/demo-repo'),
      expectedBranch: '',
    });
    expect(result.ok).toBe(true);

    // Warning logged, no SHA persisted, but the task still flips to done.
    const warnEntry = logger.entries.find((e) => e.level === 'warn' && e.message.includes('commit-task'));
    expect(warnEntry).toBeDefined();
    const reread = await deps.taskRepo.findById(sprint.id, task.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.commitSha).toBeUndefined();
    expect(reread.value.status).toBe('done');
  });
});
