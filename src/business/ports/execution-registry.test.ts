/**
 * Port-level contract tests for `ExecutionRegistryPort`.
 *
 * These tests exercise the interface invariants using the in-memory adapter
 * as the reference implementation. Adapter-specific behaviour (scope isolation,
 * pipeline wiring) lives in `src/integration/runtime/execution-registry.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { Project, Sprint } from '@src/domain/models.ts';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { RunningExecution } from '@src/business/ports/execution-registry.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';
import { InMemoryExecutionRegistry, type PipelineRunner } from '@src/integration/runtime/execution-registry.ts';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeSprint(id: string, projectId: string): Sprint {
  return {
    id,
    name: `sprint-${id}`,
    projectId,
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    displayName: name,
    repositories: [{ id: `${id}-repo`, name: 'default', path: `/tmp/${id}` }],
  };
}

/**
 * Minimal persistence stub — only `getSprint` and `getProjectById` are
 * exercised by the registry's `start` path. Every other method throws to
 * surface accidental use as a test failure.
 */
function makePersistence(options: { sprints: Sprint[]; projects: Project[] }): PersistencePort {
  const sprintsById = new Map(options.sprints.map((s) => [s.id, s]));
  const projectsById = new Map(options.projects.map((p) => [p.id, p]));
  return {
    getSprint: (id: string) => {
      const sprint = sprintsById.get(id);
      if (!sprint) throw new Error(`sprint not found: ${id}`);
      return Promise.resolve(sprint);
    },
    getProjectById: (id: string) => {
      const project = projectsById.get(id);
      if (!project) throw new Error(`project not found: ${id}`);
      return Promise.resolve(project);
    },
  } as unknown as PersistencePort;
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

function makeBaseShared(persistence: PersistencePort): SharedDeps {
  return { persistence, logger: makeStubLogger() } as unknown as SharedDeps;
}

/**
 * A runner we can steer from the test body. Returns a controller exposing the
 * abort signal and a pair of `resolve` / `reject` hooks so each call can
 * settle on demand.
 */
interface RunnerCall {
  abortSignal: AbortSignal;
  resolve: () => void;
  reject: (err: Error) => void;
}

function makeControllableRunner(): { runner: PipelineRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: PipelineRunner = (_scopedShared, { abortSignal }) => {
    return new Promise((resolve, reject) => {
      calls.push({
        abortSignal,
        resolve: () => {
          resolve(null);
        },
        reject,
      });
    });
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe('ExecutionRegistryPort contract', () => {
  it('start — list includes the new running execution', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    const execution = await registry.start({ sprintId: 's1' });

    expect(execution.id).toBe('exec-1');
    expect(execution.status).toBe('running');
    expect(execution.projectName).toBe('project-alpha');
    expect(execution.sprintId).toBe('s1');
    expect(execution.sprint).toEqual(sprint);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('exec-1');
    expect(registry.get('exec-1')).toEqual(execution);
  });

  it('start twice on same project — second throws ExecutionAlreadyRunningError carrying first id', async () => {
    const sprintA = makeSprint('s-a', 'p1');
    const sprintB = makeSprint('s-b', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({
      sprints: [sprintA, sprintB],
      projects: [project],
    });
    const { runner } = makeControllableRunner();

    let nextId = 0;
    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: (): string => {
        nextId += 1;
        return `exec-${String(nextId)}`;
      },
    });

    const first = await registry.start({ sprintId: 's-a' });
    expect(first.id).toBe('exec-1');

    const sizeBefore = registry.list().length;

    await expect(registry.start({ sprintId: 's-b' })).rejects.toMatchObject({
      name: 'ExecutionAlreadyRunningError',
      projectName: 'project-alpha',
      existingExecutionId: 'exec-1',
    });

    // Registry state is unchanged on rejection — no dangling 'exec-2' entry,
    // and the failure fires synchronously from start() before any state is
    // mutated.
    expect(registry.list()).toHaveLength(sizeBefore);
    expect(registry.get('exec-2')).toBeNull();
  });

  it('rejects synchronously (no entry created before throw)', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    await registry.start({ sprintId: 's1' });
    const entriesBeforeThrow = registry.list().length;

    let thrown: unknown = null;
    try {
      await registry.start({ sprintId: 's1' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutionAlreadyRunningError);
    expect(registry.list().length).toBe(entriesBeforeThrow);
  });

  it('completed entries remain queryable', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner, calls } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    await registry.start({ sprintId: 's1' });
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected runner to be invoked');

    firstCall.resolve();
    // Yield once so the runner promise microtask resolves before we inspect.
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = registry.get('exec-1');
    expect(snapshot?.status).toBe('completed');
    expect(registry.list()).toHaveLength(1);
  });

  it('cancel flips status to cancelled and aborts the scoped signal', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner, calls } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    await registry.start({ sprintId: 's1' });
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected runner to be invoked');

    registry.cancel('exec-1');

    expect(firstCall.abortSignal.aborted).toBe(true);

    // A cooperating runner resolves once the abort is observed. Here we
    // resolve null to mimic that path; the registry should mark the entry
    // 'cancelled' because the abort preceded the settle.
    firstCall.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = registry.get('exec-1');
    expect(snapshot?.status).toBe('cancelled');
  });

  it('subscribers are notified on every lifecycle transition', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner, calls } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    const transitions: RunningExecution[] = [];
    const unsubscribe = registry.subscribe((execution) => {
      transitions.push(execution);
    });

    await registry.start({ sprintId: 's1' });
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected runner to be invoked');
    firstCall.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(transitions.map((t) => t.status)).toEqual(['running', 'completed']);
    expect(transitions.every((t) => t.id === 'exec-1')).toBe(true);

    unsubscribe();
  });

  it('subscribers see the failed status when the runner rejects', async () => {
    const sprint = makeSprint('s1', 'p1');
    const project = makeProject('p1', 'project-alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });
    const { runner, calls } = makeControllableRunner();

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    const statuses: string[] = [];
    registry.subscribe((execution) => {
      statuses.push(execution.status);
    });

    await registry.start({ sprintId: 's1' });
    const firstCall = calls[0];
    if (!firstCall) throw new Error('expected runner to be invoked');
    firstCall.reject(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(['running', 'failed']);
    // The failure reason is carried on the snapshot so the UI can surface it.
    expect(registry.get('exec-1')?.error?.message).toBe('boom');
  });
});
