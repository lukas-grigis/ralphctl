/**
 * Cross-sprint and cross-project concurrency integration tests.
 *
 * Regression fence for the invariant that an execution is bound to the
 * sprint it was launched against — mutating the global `currentSprint`
 * mid-run, or running two executions on different projects in parallel,
 * must not bleed across registry entries (signals, persisted task writes,
 * cancellation).
 *
 * Uses the real `FilePersistenceAdapter` against an isolated `RALPHCTL_ROOT`
 * temp dir so that "task mutations land in S1's tasks file" is verified
 * end-to-end (Zod-validated read after the runner writes).
 *
 * Pipeline runner is synthetic and gated: the test holds the gate, runs
 * the workflow-layer mutation it wants to assert against, then opens the
 * gate so the runner emits its second batch of events and persists tasks.
 * Lets the assertions read deterministic post-conditions rather than
 * racing the runner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import { FilePersistenceAdapter } from '@src/integration/persistence/persistence-adapter.ts';
import { setCurrentSprint } from '@src/integration/persistence/config.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { createMultiProjectEnv, createTestEnv, type TestEnvironment } from '@src/test-utils/setup.ts';
import { InMemoryExecutionRegistry, type PipelineRunner } from './execution-registry.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function makeGate(): Gate {
  let openFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    openFn = resolve;
  });
  return { promise, open: openFn };
}

function makeStubLogger(): LoggerPort {
  const stub: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
    child: () => stub,
    time: () => () => undefined,
  };
  return stub;
}

function makeBaseShared(persistence: FilePersistenceAdapter): SharedDeps {
  return { persistence, logger: makeStubLogger() } as unknown as SharedDeps;
}

/**
 * Build a Task that satisfies `TaskSchema` for write-back through
 * `persistence.saveTasks`. Repo is required; everything else has sensible
 * defaults so each scenario only needs to vary `id` + `name`.
 */
function makeTask(overrides: Partial<Task> & { repoId: string }): Task {
  return {
    id: 'task0001',
    name: 'integration-test task',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

/** Wait long enough for the bus's 16ms coalescing window to flush. */
function waitForBusFlush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}

// ---------------------------------------------------------------------------
// Scenario: stable sprint context across `currentSprint` mutation
// ---------------------------------------------------------------------------

describe('execution registry — sprint context is bound at launch, not read live', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnv();
    process.env['RALPHCTL_ROOT'] = env.testDir;
  });

  afterEach(async () => {
    await env.cleanup();
    delete process.env['RALPHCTL_ROOT'];
  });

  it('mutating currentSprint mid-run does not change the running execution', async () => {
    const persistence = new FilePersistenceAdapter();
    const sprintOne = await persistence.createSprint({ projectId: env.projectId, name: 'sprint-one' });
    const sprintTwo = await persistence.createSprint({ projectId: env.projectId, name: 'sprint-two' });
    await setCurrentSprint(sprintOne.id);

    const gate = makeGate();
    let observedSprintId: string | null = null;

    const runner: PipelineRunner = async (scopedShared, { sprintId }) => {
      observedSprintId = sprintId;
      // First batch — emitted before any external mutation can race in.
      scopedShared.signalBus.emit({
        type: 'task-started',
        sprintId,
        taskId: 't1',
        taskName: 'phase 1',
        timestamp: new Date(),
      });
      await gate.promise;
      // Second batch — emitted after the test has mutated `currentSprint`.
      scopedShared.signalBus.emit({
        type: 'task-finished',
        sprintId,
        taskId: 't1',
        status: 'done',
        timestamp: new Date(),
      });
      // Persist a task against the captured sprintId — proves the runner
      // wrote to the launch-bound sprint, not whatever `currentSprint`
      // happens to be when the write executes.
      await scopedShared.persistence.saveTasks([makeTask({ repoId: env.repoId, name: 'persisted by run' })], sprintId);
      return null;
    };

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    const execution = await registry.start({ sprintId: sprintOne.id });
    expect(execution.sprintId).toBe(sprintOne.id);

    const captured: HarnessEvent[] = [];
    const bus = registry.getSignalBus(execution.id);
    expect(bus).not.toBeNull();
    bus?.subscribe((events) => {
      captured.push(...events);
    });

    // Mutate the global currentSprint — a workflow-layer reader sees S2 now.
    await setCurrentSprint(sprintTwo.id);
    const liveCurrent = await getCurrentSprintOrThrow();
    expect(liveCurrent.id).toBe(sprintTwo.id);

    gate.open();
    // Wait for the runner's awaited persistence write + bus drain.
    await waitForBusFlush();
    await waitForBusFlush();

    expect(observedSprintId).toBe(sprintOne.id);

    // Every signal carries the launch-bound sprintId, never the mutated value.
    const sprintIdsSeen = captured
      .filter((e): e is Extract<HarnessEvent, { sprintId: string }> => 'sprintId' in e)
      .map((e) => e.sprintId);
    expect(sprintIdsSeen.length).toBeGreaterThan(0);
    for (const sid of sprintIdsSeen) {
      expect(sid).toBe(sprintOne.id);
    }

    // Task file mutations landed in S1, not S2.
    const tasksOne = await persistence.getTasks(sprintOne.id);
    const tasksTwo = await persistence.getTasks(sprintTwo.id);
    expect(tasksOne.map((t) => t.name)).toEqual(['persisted by run']);
    expect(tasksTwo).toEqual([]);
  });

  it('a workflow-layer helper reading currentSprint sees the mutation while the run stays bound to its launch sprint', async () => {
    const persistence = new FilePersistenceAdapter();
    const sprint = await persistence.createSprint({ projectId: env.projectId, name: 'sprint-anchor' });
    const sprintOther = await persistence.createSprint({ projectId: env.projectId, name: 'sprint-other' });
    await setCurrentSprint(sprint.id);

    const gate = makeGate();
    let runnerSprintId: string | null = null;

    const runner: PipelineRunner = async (scopedShared, { sprintId }) => {
      runnerSprintId = sprintId;
      scopedShared.signalBus.emit({
        type: 'task-started',
        sprintId,
        taskId: 't-edit',
        taskName: 'editing-while-running',
        timestamp: new Date(),
      });
      await gate.promise;
      scopedShared.signalBus.emit({
        type: 'task-step',
        sprintId,
        taskId: 't-edit',
        stepName: 'apply',
        phase: 'finish',
        timestamp: new Date(),
      });
      await scopedShared.persistence.saveTasks(
        [makeTask({ repoId: env.repoId, name: 'editing-while-running write' })],
        sprintId
      );
      return null;
    };

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-edit',
    });

    const execution = await registry.start({ sprintId: sprint.id });
    const captured: HarnessEvent[] = [];
    registry.getSignalBus(execution.id)?.subscribe((events) => {
      captured.push(...events);
    });

    // Concurrently: the user opens a different sprint in the same project
    // and a workflow helper (e.g. ticket-add-view's preflight) reads
    // `getCurrentSprintOrThrow()` after the mutation. The helper must see
    // the new sprint — the running execution must not.
    await setCurrentSprint(sprintOther.id);
    const helperSprint = await getCurrentSprintOrThrow();
    expect(helperSprint.id).toBe(sprintOther.id);

    gate.open();
    await waitForBusFlush();
    await waitForBusFlush();

    expect(runnerSprintId).toBe(sprint.id);
    const sprintIdsSeen = captured
      .filter((e): e is Extract<HarnessEvent, { sprintId: string }> => 'sprintId' in e)
      .map((e) => e.sprintId);
    expect(sprintIdsSeen.length).toBeGreaterThan(0);
    for (const sid of sprintIdsSeen) {
      expect(sid).toBe(sprint.id);
    }

    const anchorTasks = await persistence.getTasks(sprint.id);
    const otherTasks = await persistence.getTasks(sprintOther.id);
    expect(anchorTasks.map((t) => t.name)).toEqual(['editing-while-running write']);
    expect(otherTasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario: cross-project parallelism + cancellation isolation
// ---------------------------------------------------------------------------

describe('execution registry — cross-project executions are independent', () => {
  let multi: Awaited<ReturnType<typeof createMultiProjectEnv>>;
  let sprintAlpha: Sprint;
  let sprintBeta: Sprint;
  let alphaRepoId: string;
  let betaRepoId: string;

  beforeEach(async () => {
    multi = await createMultiProjectEnv([
      { name: 'alpha', displayName: 'Alpha' },
      { name: 'beta', displayName: 'Beta' },
    ]);
    process.env['RALPHCTL_ROOT'] = multi.testDir;

    const persistence = new FilePersistenceAdapter();
    sprintAlpha = await persistence.createSprint({ projectId: 'prj00001', name: 'alpha-sprint' });
    sprintBeta = await persistence.createSprint({ projectId: 'prj00002', name: 'beta-sprint' });
    alphaRepoId = multi.repoIds.get('alpha') ?? '';
    betaRepoId = multi.repoIds.get('beta') ?? '';
    expect(alphaRepoId).not.toBe('');
    expect(betaRepoId).not.toBe('');
  });

  afterEach(async () => {
    await multi.cleanup();
    delete process.env['RALPHCTL_ROOT'];
  });

  it('two executions on different projects run in parallel without signal cross-talk; cancelling one leaves the other intact', async () => {
    const persistence = new FilePersistenceAdapter();

    // Per-execution gates so the test can drive each runner independently.
    const gates = new Map<string, Gate>([
      [sprintAlpha.id, makeGate()],
      [sprintBeta.id, makeGate()],
    ]);

    const runner: PipelineRunner = async (scopedShared, { sprintId, abortSignal }) => {
      const repoId = sprintId === sprintAlpha.id ? alphaRepoId : betaRepoId;
      // First batch — both pipelines reach this point before either gate opens.
      scopedShared.signalBus.emit({
        type: 'task-started',
        sprintId,
        taskId: `${sprintId}-t1`,
        taskName: `start ${sprintId}`,
        timestamp: new Date(),
      });
      const gate = gates.get(sprintId);
      // Race the gate against the abort signal — alpha is cancelled before
      // its gate ever opens, so the runner must not block forever.
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          abortSignal.removeEventListener('abort', onAbort);
          resolve();
        };
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener('abort', onAbort);
        void gate?.promise.then(() => {
          abortSignal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      if (abortSignal.aborted) {
        return null;
      }
      scopedShared.signalBus.emit({
        type: 'task-finished',
        sprintId,
        taskId: `${sprintId}-t1`,
        status: 'done',
        timestamp: new Date(),
      });
      await scopedShared.persistence.saveTasks([makeTask({ repoId, name: `done ${sprintId}` })], sprintId);
      return null;
    };

    let idCounter = 0;
    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: (): string => {
        idCounter += 1;
        return `exec-${String(idCounter)}`;
      },
    });

    const execAlpha = await registry.start({ sprintId: sprintAlpha.id });
    const execBeta = await registry.start({ sprintId: sprintBeta.id });

    expect(registry.list()).toHaveLength(2);
    expect(registry.get(execAlpha.id)?.status).toBe('running');
    expect(registry.get(execBeta.id)?.status).toBe('running');

    const alphaCaptured: HarnessEvent[] = [];
    const betaCaptured: HarnessEvent[] = [];
    registry.getSignalBus(execAlpha.id)?.subscribe((events) => {
      alphaCaptured.push(...events);
    });
    registry.getSignalBus(execBeta.id)?.subscribe((events) => {
      betaCaptured.push(...events);
    });

    // Let the first batch of emissions drain into the per-execution buses.
    await waitForBusFlush();

    // Both buses received only their own execution's start event.
    expect(alphaCaptured.length).toBeGreaterThan(0);
    expect(betaCaptured.length).toBeGreaterThan(0);
    for (const e of alphaCaptured) {
      if ('sprintId' in e) expect(e.sprintId).toBe(sprintAlpha.id);
    }
    for (const e of betaCaptured) {
      if ('sprintId' in e) expect(e.sprintId).toBe(sprintBeta.id);
    }

    // Cancel alpha. Alpha's gate stays closed; the runner exits via the
    // abort branch and the registry transitions to `'cancelled'`.
    const alphaCapturedAtCancel = alphaCaptured.length;
    registry.cancel(execAlpha.id);
    await waitForBusFlush();
    await waitForBusFlush();

    expect(registry.get(execAlpha.id)?.status).toBe('cancelled');
    // Cancelling alpha did not retroactively drop its captured signals.
    expect(alphaCaptured.length).toBe(alphaCapturedAtCancel);
    // Beta is untouched and still running.
    expect(registry.get(execBeta.id)?.status).toBe('running');

    // Beta progresses and completes independently.
    gates.get(sprintBeta.id)?.open();
    await waitForBusFlush();
    await waitForBusFlush();
    // Wait for the runner promise to settle so the registry transitions.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registry.get(execBeta.id)?.status).toBe('completed');
    // Beta's bus eventually saw both start and finish events; alpha never did.
    expect(betaCaptured.some((e) => e.type === 'task-finished')).toBe(true);
    expect(alphaCaptured.some((e) => e.type === 'task-finished')).toBe(false);

    // Persisted task writes landed in the right per-sprint files.
    const alphaTasks = await persistence.getTasks(sprintAlpha.id);
    const betaTasks = await persistence.getTasks(sprintBeta.id);
    expect(alphaTasks).toEqual([]); // never reached the save call
    expect(betaTasks.map((t) => t.name)).toEqual([`done ${sprintBeta.id}`]);
  });
});
