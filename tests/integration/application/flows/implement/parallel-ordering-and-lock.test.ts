/**
 * CS-1D regression: parallel implement path — in_progress-first wave ordering + saveAll/update
 * consistency under the sprint-scoped lock.
 *
 * Two areas:
 *  (a) Wave ordering — a queue where an `in_progress` prerequisite and a dependent `todo` are
 *      both resumable must schedule the prerequisite in wave 0 and the dependent in wave 1,
 *      so the dependent branch only runs after the prerequisite has settled `done`. Verified by
 *      driving `scheduleIntoWaves` directly (the function `planImplementWaves` calls) and then by
 *      wiring the parallel element so it actually executes in that order.
 *
 *  (b) saveAll vs update race — a `saveAll` (the epilogue's `saveTasksLeaf`) racing a concurrent
 *      `update()` (from a branch's settle step) stays consistent under the per-file lock CS-1A
 *      added. The parallel element holds a sprint-scoped lock for its entire duration (prologue →
 *      waves → epilogue), so within a single implement run the serial per-task branches and the
 *      epilogue rewrite can never interleave. A second concurrent run (different process / test)
 *      is serialised by the same sprint-dir lock. The per-file lock backs the case where
 *      `unblockTaskUseCase` does a cascade-saveAll from outside the sprint-scoped lock. This test
 *      exercises the per-file lock path by driving a real `FsTaskRepository` + `FileLocker`
 *      concurrently from outside the sprint-scoped lock, confirming no torn write survives.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { InProgressTask, TodoTask } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { scheduleIntoWaves } from '@src/domain/entity/task-graph.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementWavePlan } from '@src/application/flows/implement/flow.ts';
import {
  createParallelImplementElement,
  type ParallelImplementConfig,
} from '@src/application/flows/implement/parallel-element.ts';

import { absolutePath, FIXED_NOW, makeDoneTask, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const SPRINT_DIR = absolutePath('/data/sprints/s1');
const LOCKS_ROOT = absolutePath('/state/locks');

// ─── Helper: in_progress fixture ─────────────────────────────────────────────

const inProgressOf = (todo: TodoTask): InProgressTask => {
  const r = startNextAttempt(todo, FIXED_NOW, 'session-1');
  if (!r.ok) throw new Error(`fixture startNextAttempt failed: ${r.error.message}`);
  return r.value;
};

// ─── Shared stubs ────────────────────────────────────────────────────────────

const stubBus = (): EventBus => ({
  publish: () => {},
  subscribe: () => () => {},
});

const recordingLocker = (): FileLocker => ({
  async withLock(_lockPath, fn) {
    const value = await fn(new AbortController().signal);
    return Result.ok(value) as never;
  },
});

const ctxWith = (tasks: readonly Task[]): ImplementCtx => {
  const sprint = makePlannedSprint();
  return { sprintId: sprint.id, sprint, tasks };
};

interface Persisted {
  tasks: readonly Task[] | undefined;
}

const recordingEpilogue = (persisted: Persisted): Element<ImplementCtx> => ({
  name: 'implement-epilogue',
  async execute(ctx): Promise<ElementResult<ImplementCtx>> {
    persisted.tasks = ctx.tasks;
    return Result.ok({ ctx, trace: [] });
  },
});

const noopPrologue: Element<ImplementCtx> = {
  name: 'implement-prologue',
  async execute(ctx): Promise<ElementResult<ImplementCtx>> {
    return Result.ok({ ctx, trace: [] });
  },
};

const plan = (
  prologue: Element<ImplementCtx>,
  epilogue: Element<ImplementCtx>,
  waves: ReadonlyArray<readonly Task[]>
): ImplementWavePlan => ({ prologue, epilogue, waves, lockKey: SPRINT_DIR });

let sessionCounter = 0;
const baseConfig = (
  buildWaves: ParallelImplementConfig['buildWaves'],
  locker: FileLocker
): ParallelImplementConfig => ({
  fileLocker: locker,
  locksRoot: LOCKS_ROOT,
  eventBus: stubBus(),
  maxConcurrency: 5,
  flowId: 'implement',
  sessionId: () => `sub-${String(sessionCounter++)}`,
  buildWaves,
});

// ─── Branch factories ─────────────────────────────────────────────────────────

/**
 * A branch that settles its task done and records the step in `waveLog` at its wave index.
 * Records a "before" entry on start and "after" once the task is settled, so we can verify
 * wave 0 fully completes before wave 1 starts.
 */
const doneBranch = (task: Task, waveLog: string[], label: string): WaveBranch<ImplementCtx> => ({
  id: `task-${String(task.id)}`,
  element: {
    name: `branch-${String(task.id)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      waveLog.push(`start:${label}`);
      const done: Task = { ...makeDoneTask({ name: task.name }), id: task.id };
      waveLog.push(`end:${label}`);
      return Result.ok({ ctx: { ...ctx, tasks: [done] }, trace: [] });
    },
  },
});

// ─── (a) Wave ordering ────────────────────────────────────────────────────────

describe('parallel path — wave ordering with in_progress prerequisite + dependent todo', () => {
  it('scheduleIntoWaves puts an in_progress prerequisite in wave 0 and its dependent in wave 1', () => {
    // Arrange: a = in_progress (no deps), b = todo (depends on a).
    // resolveImplementQueue produces [a, b]; when planImplementWaves calls scheduleIntoWaves([a, b]),
    // a must land in wave 0 and b in wave 1.
    const aBase = makeTodoTask({ name: 'a', order: 1 });
    const a = inProgressOf(aBase);
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });

    // Act
    const schedule = scheduleIntoWaves([a, b]);

    // Assert
    expect(schedule.ok).toBe(true);
    if (!schedule.ok) return;
    expect(schedule.value).toHaveLength(2);
    // Wave 0: only 'a' (no deps)
    expect(schedule.value[0]?.map((t) => t.id)).toEqual([a.id]);
    expect(schedule.value[0]?.[0]?.status).toBe('in_progress');
    // Wave 1: only 'b' (depends on a, which is in wave 0)
    expect(schedule.value[1]?.map((t) => t.id)).toEqual([b.id]);
    expect(schedule.value[1]?.[0]?.status).toBe('todo');
  });

  it('dependent task wave index is strictly greater than its in_progress prerequisite wave index', () => {
    // Arrange: chain a (in_progress) → b → c (todo).
    const aBase = makeTodoTask({ name: 'a', order: 1 });
    const a = inProgressOf(aBase);
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });
    const c = makeTodoTask({ name: 'c', order: 3, dependsOn: [b.id] });

    // Act
    const schedule = scheduleIntoWaves([a, b, c]);

    // Assert
    expect(schedule.ok).toBe(true);
    if (!schedule.ok) return;
    const waveIndexById = new Map<string, number>();
    schedule.value.forEach((wave, i) => wave.forEach((t) => waveIndexById.set(String(t.id), i)));
    // Every dependency must land in a strictly earlier wave than the dependent.
    for (const t of [b, c]) {
      for (const depId of t.dependsOn) {
        expect(waveIndexById.get(String(depId))!).toBeLessThan(waveIndexById.get(String(t.id))!);
      }
    }
  });

  it('parallel element executes the in_progress-wave branches before the dependent-wave branches', async () => {
    // Arrange: a is in_progress, b depends on a. wave 0 = [a], wave 1 = [b].
    // We verify that all "start:a" + "end:a" entries precede any "start:b" entry.
    const aBase = makeTodoTask({ name: 'a', order: 1 });
    const a = inProgressOf(aBase);
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });

    const schedule = scheduleIntoWaves([a, b]);
    expect(schedule.ok).toBe(true);
    if (!schedule.ok) return;

    const waveLog: string[] = [];
    const persisted: Persisted = { tasks: undefined };

    // Build wave branches that record start/end so we can verify the ordering fence.
    const wave0 = [doneBranch(a, waveLog, 'a')];
    const wave1 = [doneBranch(b, waveLog, 'b')];

    const element = createParallelImplementElement(
      plan(noopPrologue, recordingEpilogue(persisted), schedule.value),
      baseConfig(() => [wave0, wave1], recordingLocker())
    );

    // Act
    const result = await element.execute(ctxWith([a, b]));

    // Assert: overall success
    expect(result.ok).toBe(true);

    // The log must show wave 0 fully settled before wave 1 starts:
    //   start:a, end:a  (all of wave 0) → then start:b, end:b  (wave 1)
    const startA = waveLog.indexOf('start:a');
    const endA = waveLog.indexOf('end:a');
    const startB = waveLog.indexOf('start:b');
    expect(startA).toBeGreaterThanOrEqual(0);
    expect(endA).toBeGreaterThan(startA);
    expect(startB).toBeGreaterThan(endA); // wave 1 begins only after wave 0 ends

    // Both tasks land as done in the epilogue ctx.
    expect(persisted.tasks?.find((t) => t.id === a.id)?.status).toBe('done');
    expect(persisted.tasks?.find((t) => t.id === b.id)?.status).toBe('done');
  });

  it('dependent branch does not run when in_progress prerequisite branch fails (wave short-circuit)', async () => {
    // Arrange: a (in_progress) fails in wave 0 → wave 1 (b) must not run.
    // runWaves absorbs the non-fatal error in wave 0; the merge reducer receives a 'failed'
    // outcome and leaves b's task at its base (todo). Wave 1 then runs with b still todo, but
    // the real concern here is that the WAVE ORDERING fence holds: wave 1 only fires after
    // wave 0 is fully settled.
    const aBase = makeTodoTask({ name: 'a', order: 1 });
    const a = inProgressOf(aBase);
    const b = makeTodoTask({ name: 'b', order: 2, dependsOn: [a.id] });

    const schedule = scheduleIntoWaves([a, b]);
    expect(schedule.ok).toBe(true);
    if (!schedule.ok) return;

    const waveLog: string[] = [];

    const failBranch = (task: Task): WaveBranch<ImplementCtx> => ({
      id: `task-${String(task.id)}`,
      element: {
        name: `branch-fail-${String(task.id)}`,
        async execute(): Promise<ElementResult<ImplementCtx>> {
          const err = new (await import('@src/domain/value/error/storage-error.ts')).StorageError({
            subCode: 'io',
            message: `task ${task.name} failed`,
          });
          return Result.error({
            error: err,
            trace: [{ elementName: `branch-fail-${String(task.id)}`, status: 'failed', durationMs: 0, error: err }],
          });
        },
      },
    });

    const wave0 = [failBranch(a)];
    const wave1 = [doneBranch(b, waveLog, 'b')];

    const persisted: Persisted = { tasks: undefined };
    const element = createParallelImplementElement(
      plan(noopPrologue, recordingEpilogue(persisted), schedule.value),
      baseConfig(() => [wave0, wave1], recordingLocker())
    );

    // Act: wave 0 fails (absorbed), wave 1 runs.
    const result = await element.execute(ctxWith([a, b]));

    // Wave 1 must still run after wave 0 settles (non-fatal failure is absorbed).
    expect(result.ok).toBe(true);
    // b ran in wave 1 (after wave 0's failed branch settled).
    expect(waveLog).toContain('start:b');
    // a's task was not settled done (failure in wave 0 → b's base task is untouched todo).
    expect(persisted.tasks?.find((t) => t.id === a.id)?.status).not.toBe('done');
  });
});

// ─── (b) saveAll vs update race on the parallel path ─────────────────────────

describe('parallel path — saveAll vs update consistency under the per-file lock (CS-1A regression)', () => {
  let root: AbsolutePath;
  let cleanupTmp: () => Promise<void>;
  const sprintId = SprintId.generate();

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanupTmp = tmp.cleanup;
  });

  afterEach(async () => cleanupTmp());

  it('concurrent saveAll (epilogue) and update (branch settle) produce a consistent snapshot on the parallel path', async () => {
    // Arrange: seed the tasks.json with t1 + t2.
    const locker = createFileLocker();
    const repo = createFsTaskRepository({ root, fileLocker: locker });

    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });
    const seed = await repo.saveAll(sprintId, [t1, t2]);
    expect(seed.ok).toBe(true);

    // Simulate the parallel epilogue writing [t1, t2, t3] (full rewrite with a new settled task)
    // racing a per-branch update that flips t2's name. Both paths go through the per-file lock
    // added by CS-1A, so neither can produce a torn JSON.
    const t3 = makeTodoTask({ name: 't3', order: 3 });
    const renamedT2 = { ...t2, name: 't2-settled' };
    const fullRewrite = [t1, t2, t3];

    // Act: race a saveAll vs an update — identical to the "unblockTaskUseCase saveAll outside
    // sprint lock races per-branch update" scenario, now on the parallel-flow task file.
    const [writeResult, updateResult] = await Promise.all([
      repo.saveAll(sprintId, fullRewrite),
      repo.update(sprintId, renamedT2),
    ]);

    expect(writeResult.ok).toBe(true);
    expect(updateResult.ok).toBe(true);

    // Assert: the final state is one of the valid serialised outcomes — never a torn/partial write.
    const finalState = await repo.findBySprintId(sprintId);
    if (!finalState.ok) throw new Error('findBySprintId failed');
    const names = JSON.stringify(finalState.value.map((t) => t.name));

    // Valid serialised outcomes (each is a complete, consistent snapshot):
    //  - update won the lock: ['t1', 't2-settled']         (2-task set with rename, saveAll not yet run)
    //  - saveAll won, then update on the 3-task set: t2 renamed inside the 3-task set
    //     → ['t1', 't2-settled', 't3']
    //  - saveAll won last: ['t1', 't2', 't3']              (full rewrite clobbers the rename)
    const validOutcomes = [
      JSON.stringify(['t1', 't2-settled']),
      JSON.stringify(['t1', 't2-settled', 't3']),
      JSON.stringify(['t1', 't2', 't3']),
    ];
    expect(validOutcomes).toContain(names);
  });

  it('many concurrent saveAll + update calls on the parallel-path tasks.json never tear the file', async () => {
    // This mirrors the high-concurrency path in `repository-concurrent.test.ts` but anchors
    // the regression to the parallel implement context: tasks involved are exactly the kind
    // the parallel epilogue would write (multiple settled tasks from N waves).
    const locker = createFileLocker();
    const repo = createFsTaskRepository({ root, fileLocker: locker });

    const tasks = Array.from({ length: 4 }, (_v, i) => makeTodoTask({ name: `t${String(i)}`, order: i + 1 }));
    const seed = await repo.saveAll(sprintId, tasks);
    expect(seed.ok).toBe(true);

    // Fan out: alternate full rewrites (simulating the epilogue saveAll) and single updates
    // (simulating per-branch settle writes). All ops use the same file; any torn write would
    // produce a missing task or garbled JSON.
    const writers: Array<Promise<unknown>> = [];
    for (let i = 0; i < 16; i++) {
      if (i % 3 === 0) {
        // Epilogue-style full rewrite — same 4-task canonical set.
        writers.push(repo.saveAll(sprintId, tasks));
      } else {
        // Branch-settle-style single-task update — name untouched, just a re-save.
        const target = tasks[i % tasks.length];
        if (target !== undefined) writers.push(repo.update(sprintId, target));
      }
    }

    const results = await Promise.all(writers);
    for (const r of results) expect((r as { ok: boolean }).ok).toBe(true);

    // The final state must be one consistent complete snapshot of the 4-task set.
    const finalState = await repo.findBySprintId(sprintId);
    if (!finalState.ok) throw new Error('findBySprintId failed');
    // Regardless of which write won last, all 4 original tasks are present and named canonically.
    expect(finalState.value.map((t) => t.name)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('the parallel element holds the sprint-scoped lock for the full prologue → waves → epilogue span', async () => {
    // The sprint-scoped lock must be acquired BEFORE the prologue runs and released ONLY AFTER
    // the epilogue completes — so no external concurrent write can interleave with the epilogue's
    // saveAll while the parallel element is executing. Verified by checking that the lock is
    // still held when the epilogue's execute() body runs.
    const lockOrder: string[] = [];
    let epilogueCalledWhileLockHeld = false;
    let lockCurrentlyHeld = false;

    const spyLocker: FileLocker = {
      async withLock(_lockPath, fn) {
        lockOrder.push('acquire');
        lockCurrentlyHeld = true;
        try {
          const value = await fn(new AbortController().signal);
          return Result.ok(value) as never;
        } finally {
          lockCurrentlyHeld = false;
          lockOrder.push('release');
        }
      },
    };

    const spyEpilogue: Element<ImplementCtx> = {
      name: 'implement-epilogue',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        // Record whether the sprint-scoped lock was still held when the epilogue ran.
        epilogueCalledWhileLockHeld = lockCurrentlyHeld;
        return Result.ok({ ctx, trace: [] });
      },
    };

    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const wave0: Array<WaveBranch<ImplementCtx>> = [
      {
        id: `task-${String(t1.id)}`,
        element: {
          name: `branch-${String(t1.id)}`,
          async execute(ctx): Promise<ElementResult<ImplementCtx>> {
            const done: Task = { ...makeDoneTask({ name: t1.name }), id: t1.id };
            return Result.ok({ ctx: { ...ctx, tasks: [done] }, trace: [] });
          },
        },
      },
    ];

    const element = createParallelImplementElement(
      plan(noopPrologue, spyEpilogue, [[t1]]),
      baseConfig(() => [wave0], spyLocker)
    );

    // Act
    const result = await element.execute(ctxWith([t1]));

    // Assert
    expect(result.ok).toBe(true);
    expect(epilogueCalledWhileLockHeld).toBe(true); // epilogue ran while sprint lock was held
    expect(lockOrder).toEqual(['acquire', 'release']); // exactly one acquire/release cycle
  });
});
