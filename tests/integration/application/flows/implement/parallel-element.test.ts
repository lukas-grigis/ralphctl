import { describe, expect, it, vi } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementWavePlan } from '@src/application/flows/implement/flow.ts';
import {
  createParallelImplementElement,
  type ParallelImplementConfig,
} from '@src/application/flows/implement/parallel-element.ts';

import { absolutePath, makeDoneTask, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const SPRINT_DIR = absolutePath('/data/sprints/s1');
const LOCKS_ROOT = absolutePath('/state/locks');

const stubBus = (events: AppEvent[]): EventBus => ({
  publish: (e) => events.push(e),
  subscribe: () => () => {},
});

/** A real-ish file locker that records lock/unlock order and holds the lock across `fn`. */
const recordingLocker = (log: string[]): FileLocker => ({
  async withLock(_lockPath, fn) {
    log.push('lock-acquire');
    try {
      const value = await fn(new AbortController().signal);
      return Result.ok(value) as never;
    } finally {
      log.push('lock-release');
    }
  },
});

/** A file locker that always fails to acquire (contention). */
const failingLocker = (): FileLocker => ({
  async withLock() {
    return Result.error(new StorageError({ subCode: 'lock', message: 'contended' }));
  },
});

/** A trivial element that tags ctx and records its run in `log`. */
const tagElement = (name: string, log: string[], tag?: (ctx: ImplementCtx) => ImplementCtx): Element<ImplementCtx> => ({
  name,
  async execute(ctx): Promise<ElementResult<ImplementCtx>> {
    log.push(name);
    return Result.ok({ ctx: tag ? tag(ctx) : ctx, trace: [] });
  },
});

/** Mutable cell recording the task list the epilogue stand-in was handed (mimics `saveTasksLeaf`). */
interface Persisted {
  tasks: readonly Task[] | undefined;
}

/** An epilogue stand-in that records the `tasks` it was handed (mimics `saveTasksLeaf`). */
const recordingEpilogue = (log: string[], persisted: Persisted): Element<ImplementCtx> => ({
  name: 'implement-epilogue',
  async execute(ctx): Promise<ElementResult<ImplementCtx>> {
    log.push('epilogue');
    persisted.tasks = ctx.tasks;
    return Result.ok({ ctx, trace: [] });
  },
});

/**
 * A branch element that completes immediately, settling its task `done`. Mirrors the real branch
 * contract: the outcome ctx carries ONLY the branch's OWN task (so the merge overlay is disjoint).
 */
const doneBranch = (task: Task, log: string[]): WaveBranch<ImplementCtx> => ({
  id: `task-${String(task.id)}`,
  element: {
    name: `branch-${String(task.id)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      log.push(`branch-${task.name}`);
      const done: Task = { ...makeDoneTask({ name: task.name }), id: task.id };
      return Result.ok({ ctx: { ...ctx, tasks: [done] }, trace: [] });
    },
  },
});

/** A branch element that hangs until aborted (mimics a long task killed mid-flight). */
const hangingBranch = (task: Task, log: string[], cleanups: string[]): WaveBranch<ImplementCtx> => ({
  id: `task-${String(task.id)}`,
  element: {
    name: `branch-${String(task.id)}`,
    async execute(_ctx, signal): Promise<ElementResult<ImplementCtx>> {
      log.push(`branch-${task.name}`);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      cleanups.push(task.name); // a stand-in for worktree cleanup
      const error = new AbortError({ elementName: `branch-${String(task.id)}` });
      return Result.error({
        error,
        trace: [{ elementName: `branch-${String(task.id)}`, status: 'aborted', durationMs: 0, error }],
      });
    },
  },
});

const plan = (
  prologue: Element<ImplementCtx>,
  epilogue: Element<ImplementCtx>,
  waves: ReadonlyArray<readonly Task[]>
): ImplementWavePlan => ({ prologue, epilogue, waves, lockKey: SPRINT_DIR });

const baseConfig = (
  over: Partial<ParallelImplementConfig> & { buildWaves: ParallelImplementConfig['buildWaves'] },
  locker: FileLocker,
  bus: EventBus
): ParallelImplementConfig => ({
  fileLocker: locker,
  locksRoot: LOCKS_ROOT,
  eventBus: bus,
  maxConcurrency: 3,
  flowId: 'implement',
  sessionId: (() => {
    let n = 0;
    return () => `sub-${String(n++)}`;
  })(),
  ...over,
});

const ctxWith = (tasks: readonly Task[]): ImplementCtx => {
  const sprint = makePlannedSprint();
  return { sprintId: sprint.id, sprint, tasks };
};

describe('createParallelImplementElement — happy path under one held lock', () => {
  it('runs prologue → waves → epilogue inside ONE held lock, in that order', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const log: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const lockLog: string[] = [];
    const locker = recordingLocker(lockLog);
    const bus = stubBus([]);

    const prologue = tagElement('implement-prologue', log);
    const epilogue = recordingEpilogue(log, persisted);
    const branches = [[doneBranch(t1, log), doneBranch(t2, log)]];

    const element = createParallelImplementElement(
      plan(prologue, epilogue, [[t1, t2]]),
      baseConfig({ buildWaves: () => branches }, locker, bus)
    );
    const result = await element.execute(ctxWith([t1, t2]));

    expect(result.ok).toBe(true);
    // Prologue before any branch; epilogue after both branches; all between lock acquire + release.
    expect(log[0]).toBe('implement-prologue');
    expect(log[log.length - 1]).toBe('epilogue');
    expect(lockLog).toEqual(['lock-acquire', 'lock-release']);
    // Epilogue persisted both tasks done.
    expect(persisted.tasks?.every((t) => t.status === 'done')).toBe(true);
  });
});

describe('createParallelImplementElement — B4 abort durability gate', () => {
  it('persists task-1 (folded) as done on abort during task-2; tasks 2/3 stay todo; AbortError verbatim', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const t3 = makeTodoTask({ name: 't3' });
    const log: string[] = [];
    const cleanups: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const lockLog: string[] = [];
    const locker = recordingLocker(lockLog);
    const bus = stubBus([]);
    const ac = new AbortController();

    // Wave of 3: t1 folds done immediately; t2 + t3 hang. Abort fires after t1 completes.
    const branches = [
      [completeThenAbort(t1, log, ac), hangingBranch(t2, log, cleanups), hangingBranch(t3, log, cleanups)],
    ];

    const prologue = tagElement('implement-prologue', log);
    const epilogue = recordingEpilogue(log, persisted);

    const element = createParallelImplementElement(
      plan(prologue, epilogue, [[t1, t2, t3]]),
      baseConfig({ buildWaves: () => branches, maxConcurrency: 3 }, locker, bus)
    );
    const result = await element.execute(ctxWith([t1, t2, t3]), ac.signal);

    // AbortError propagates verbatim so the sprint stays runnable.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);

    // THE B4 GATE: the epilogue STILL ran (under the lock) on the partially-merged ctx, so task-1's
    // fold is durably recorded as done; tasks 2 + 3 reset to todo (never folded) and re-run.
    expect(log).toContain('epilogue');
    expect(persisted.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    expect(persisted.tasks?.find((t) => t.id === t2.id)?.status).toBe('todo');
    expect(persisted.tasks?.find((t) => t.id === t3.id)?.status).toBe('todo');
    // The hanging branches ran their cleanup (worktree teardown stand-in).
    expect(cleanups.sort()).toEqual(['t2', 't3']);
    // Everything stayed inside the single held lock.
    expect(lockLog).toEqual(['lock-acquire', 'lock-release']);
  });
});

/** A branch that settles task `done`, then trips the abort controller so siblings get killed. */
const completeThenAbort = (task: Task, log: string[], ac: AbortController): WaveBranch<ImplementCtx> => ({
  id: `task-${String(task.id)}`,
  element: {
    name: `branch-${String(task.id)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      log.push(`branch-${task.name}`);
      const done: Task = { ...makeDoneTask({ name: task.name }), id: task.id };
      // Fire the abort on the next microtask so this branch completes first, THEN siblings are killed.
      queueMicrotask(() => ac.abort());
      return Result.ok({ ctx: { ...ctx, tasks: [done] }, trace: [] });
    },
  },
});

describe('createParallelImplementElement — prologue failure', () => {
  it('still runs the epilogue under the lock, then propagates the prologue error', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const log: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const lockLog: string[] = [];
    const bus = stubBus([]);

    const failingPrologue: Element<ImplementCtx> = {
      name: 'implement-prologue',
      async execute(): Promise<ElementResult<ImplementCtx>> {
        log.push('implement-prologue');
        const error = new StorageError({ subCode: 'io', message: 'dirty tree' });
        return Result.error({
          error,
          trace: [{ elementName: 'implement-prologue', status: 'failed', durationMs: 0, error }],
        });
      },
    };
    const epilogue = recordingEpilogue(log, persisted);
    const buildWaves = vi.fn(() => [] as ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>>);

    const element = createParallelImplementElement(
      plan(failingPrologue, epilogue, [[t1]]),
      baseConfig({ buildWaves }, recordingLocker(lockLog), bus)
    );
    const result = await element.execute(ctxWith([t1]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(StorageError);
    // Waves never built (no prologue success); epilogue still ran under the lock.
    expect(buildWaves).not.toHaveBeenCalled();
    expect(log).toEqual(['implement-prologue', 'epilogue']);
    expect(lockLog).toEqual(['lock-acquire', 'lock-release']);
  });
});

describe('createParallelImplementElement — lock contention', () => {
  it('surfaces the lock failure without running prologue / waves / epilogue', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const log: string[] = [];
    const buildWaves = vi.fn(() => [] as ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>>);

    const element = createParallelImplementElement(
      plan(tagElement('implement-prologue', log), tagElement('implement-epilogue', log), [[t1]]),
      baseConfig({ buildWaves }, failingLocker(), stubBus([]))
    );
    const result = await element.execute(ctxWith([t1]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(StorageError);
    expect(log).toEqual([]);
    expect(buildWaves).not.toHaveBeenCalled();
  });
});

describe('createParallelImplementElement — uses the sprint-dir lock key', () => {
  it('locks on repoLockFile(locksRoot, sprintDir) — same key the serial path uses', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    let lockedPath: AbsolutePath | undefined;
    const locker: FileLocker = {
      async withLock(lockPath, fn) {
        lockedPath = lockPath;
        return Result.ok(await fn(new AbortController().signal)) as never;
      },
    };
    const element = createParallelImplementElement(
      plan(tagElement('implement-prologue', []), recordingEpilogue([], { tasks: undefined }), [[t1]]),
      baseConfig({ buildWaves: () => [[doneBranch(t1, [])]] }, locker, stubBus([]))
    );
    await element.execute(ctxWith([t1]));

    // The lock path is derived from the sprint-dir lock key (a `repo-<hash>.lock` under locksRoot).
    expect(lockedPath).toBeDefined();
    expect(String(lockedPath)).toContain(String(LOCKS_ROOT));
    expect(String(lockedPath)).toMatch(/repo-[0-9a-f]{16}\.lock$/);
  });
});

describe('createParallelImplementElement — lock contention (subCode)', () => {
  it('returns StorageError with subCode lock and never calls buildWaves when lock is contended', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const buildWaves = vi.fn(() => [] as ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>>);
    const log: string[] = [];

    const element = createParallelImplementElement(
      plan(tagElement('implement-prologue', log), tagElement('implement-epilogue', log), [[t1]]),
      baseConfig({ buildWaves }, failingLocker(), stubBus([]))
    );
    const result = await element.execute(ctxWith([t1]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(StorageError);
    expect((result.error.error as StorageError).subCode).toBe('lock');
    // No prologue/epilogue ran and no branch was built.
    expect(log).toEqual([]);
    expect(buildWaves).not.toHaveBeenCalled();
  });
});

describe('createParallelImplementElement — no EventBus subscriber leak after wave settles', () => {
  it('returns live-listener count to baseline (0 net) after execute resolves', async () => {
    const t1 = makeTodoTask({ name: 't1' });
    const log: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const lockLog: string[] = [];
    const locker = recordingLocker(lockLog);

    // Counting EventBus: subscribe increments the live counter; the returned unsubscribe
    // decrements it. After execute() the counter must be back to 0.
    let liveListeners = 0;
    const countingBus: EventBus = {
      publish: () => {},
      subscribe: (handler) => {
        liveListeners++;
        let active = true;
        const wrapped = (e: AppEvent): void => {
          if (active) handler(e);
        };
        // We must satisfy the EventBus contract: subscribe returns an unsubscribe fn.
        // The bus itself doesn't hold `wrapped` — bridgeRunnerToEventBus holds the unsub.
        void wrapped;
        return () => {
          if (active) {
            active = false;
            liveListeners--;
          }
        };
      },
    };

    const prologue = tagElement('implement-prologue', log);
    const epilogue = recordingEpilogue(log, persisted);
    const branches = [[doneBranch(t1, log)]];

    const element = createParallelImplementElement(
      plan(prologue, epilogue, [[t1]]),
      baseConfig({ buildWaves: () => branches }, locker, countingBus)
    );
    await element.execute(ctxWith([t1]));

    // All bridged subscriptions (prologue sub-runner, branch runner, epilogue sub-runner) must have
    // self-detached on terminal — zero net listeners left over.
    expect(liveListeners).toBe(0);
  });

  it('returns live-listener count to baseline (0 net) even when the wave is ABORTED mid-flight', async () => {
    // The leak the guaranteed-teardown fix targets: a branch killed by an outer abort that does not
    // deliver a clean terminal must STILL have its bridge + durable-fold subscriptions force-detached
    // by the wave-level finally. Without it, each aborted branch leaves a permanent EventBus closure
    // pinning its runner + forked ctx + trace ring for the whole TUI session.
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const log: string[] = [];
    const cleanups: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const ac = new AbortController();

    let liveListeners = 0;
    const countingBus: EventBus = {
      publish: () => {},
      subscribe: () => {
        liveListeners++;
        let active = true;
        return () => {
          if (active) {
            active = false;
            liveListeners--;
          }
        };
      },
    };

    // t1 completes then trips the abort; t2 hangs until killed (never a clean terminal of its own
    // before the kill). After execute() resolves, every per-branch + sub-runner listener must be gone.
    const branches = [[completeThenAbort(t1, log, ac), hangingBranch(t2, log, cleanups)]];

    const element = createParallelImplementElement(
      plan(tagElement('implement-prologue', log), recordingEpilogue(log, persisted), [[t1, t2]]),
      baseConfig({ buildWaves: () => branches, maxConcurrency: 2 }, recordingLocker([]), countingBus)
    );
    const result = await element.execute(ctxWith([t1, t2]), ac.signal);

    expect(result.ok).toBe(false);
    expect(liveListeners).toBe(0);
  });
});

describe('createParallelImplementElement — 2-wave durable fold survives abort of wave 1', () => {
  it('epilogue receives wave-0 task as done and final result is AbortError when wave 1 is aborted', async () => {
    const t1 = makeTodoTask({ name: 't1' }); // wave 0 — completes
    const t2 = makeTodoTask({ name: 't2' }); // wave 1 — hangs until abort
    const log: string[] = [];
    const cleanups: string[] = [];
    const persisted: Persisted = { tasks: undefined };
    const lockLog: string[] = [];
    const locker = recordingLocker(lockLog);
    const bus = stubBus([]);

    const ac = new AbortController();

    // Wave 0: t1 completes immediately and then schedules the outer abort so wave 1 gets killed.
    const wave0Branch: WaveBranch<ImplementCtx> = {
      id: `task-${String(t1.id)}`,
      element: {
        name: `branch-${String(t1.id)}`,
        async execute(ctx): Promise<ElementResult<ImplementCtx>> {
          log.push('branch-t1');
          const done: Task = { ...makeDoneTask({ name: t1.name }), id: t1.id };
          // Defer the abort so wave 0 settles first and its ctx is folded into prologueCtx
          // before wave 1 kicks off.
          queueMicrotask(() => ac.abort());
          return Result.ok({ ctx: { ...ctx, tasks: [done] }, trace: [] });
        },
      },
    };

    const wave1Branch = hangingBranch(t2, log, cleanups);

    // 2-wave plan: wave 0 has t1, wave 1 has t2.
    const waves = [[wave0Branch], [wave1Branch]];

    const prologue = tagElement('implement-prologue', log);
    const epilogue = recordingEpilogue(log, persisted);

    const element = createParallelImplementElement(
      plan(prologue, epilogue, [[t1], [t2]]),
      baseConfig({ buildWaves: () => waves }, locker, bus)
    );
    const result = await element.execute(ctxWith([t1, t2]), ac.signal);

    // The outer result is an AbortError so the sprint stays runnable.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);

    // THE B4 GATE across waves: the epilogue ran and its ctx has t1 durably folded as done.
    expect(log).toContain('epilogue');
    expect(persisted.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    // t2 never folded (aborted mid-flight) → stays todo in the overlay.
    expect(persisted.tasks?.find((t) => t.id === t2.id)?.status).toBe('todo');

    // Everything stayed inside the single held lock.
    expect(lockLog).toEqual(['lock-acquire', 'lock-release']);
  });
});
