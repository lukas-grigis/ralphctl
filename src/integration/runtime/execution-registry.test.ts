/**
 * Adapter-specific tests for `InMemoryExecutionRegistry`.
 *
 * Port-level contract tests live in
 * `src/business/ports/execution-registry.test.ts`. Here we exercise the
 * integration details: per-execution scope isolation, signal-bus separation
 * across concurrent executions, and the `baseShared` wiring.
 */

import { describe, expect, it } from 'vitest';
import type { Project, Sprint } from '@src/domain/models.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { SharedDeps } from '@src/integration/shared-deps.ts';
import { InMemoryExecutionRegistry, type PipelineRunner } from './execution-registry.ts';

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

function makePersistence(input: { sprints: Sprint[]; projects: Project[] }): PersistencePort {
  const sprintsById = new Map(input.sprints.map((s) => [s.id, s]));
  const projectsById = new Map(input.projects.map((p) => [p.id, p]));
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

describe('InMemoryExecutionRegistry — scope isolation', () => {
  it('two executions on different projects each get distinct SignalBus instances', async () => {
    const sprintA = makeSprint('sprint-a', 'p-a');
    const sprintB = makeSprint('sprint-b', 'p-b');
    const projectA = makeProject('p-a', 'alpha');
    const projectB = makeProject('p-b', 'beta');
    const persistence = makePersistence({
      sprints: [sprintA, sprintB],
      projects: [projectA, projectB],
    });

    const scopedBuses: SignalBusPort[] = [];
    const runner: PipelineRunner = (scopedShared) => {
      scopedBuses.push(scopedShared.signalBus);
      return new Promise(() => {
        /* keep both executions pending for the duration of the test */
      });
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

    await registry.start({ sprintId: 'sprint-a' });
    await registry.start({ sprintId: 'sprint-b' });

    expect(scopedBuses).toHaveLength(2);
    const [first, second] = scopedBuses;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('scoped logger is not the base logger (execution context applied)', async () => {
    const sprint = makeSprint('s', 'p');
    const project = makeProject('p', 'alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });

    let capturedLogger: SharedDeps['logger'] | null = null;
    const runner: PipelineRunner = (scopedShared) => {
      capturedLogger = scopedShared.logger;
      return Promise.resolve(null);
    };

    const baseLogger = {
      child: () => {
        return { tag: 'scoped' } as unknown as SharedDeps['logger'];
      },
    } as unknown as SharedDeps['logger'];

    const registry = new InMemoryExecutionRegistry({
      baseShared: { persistence, logger: baseLogger } as unknown as SharedDeps,
      runner,
      generateId: () => 'exec-1',
    });

    await registry.start({ sprintId: 's' });
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedLogger).not.toBe(baseLogger);
  });

  it('completes successfully when the runner resolves without an abort', async () => {
    const sprint = makeSprint('s', 'p');
    const project = makeProject('p', 'alpha');
    const persistence = makePersistence({ sprints: [sprint], projects: [project] });

    const runner: PipelineRunner = () => Promise.resolve(null);

    const registry = new InMemoryExecutionRegistry({
      baseShared: makeBaseShared(persistence),
      runner,
      generateId: () => 'exec-1',
    });

    await registry.start({ sprintId: 's' });
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.get('exec-1')?.status).toBe('completed');
  });
});
