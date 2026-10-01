import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  purgeHousekeepingUseCase,
  type PurgeHousekeepingProps,
} from '@src/business/housekeeping/purge-housekeeping.ts';
import type {
  OrphanMemoryCandidate,
  OrphanSprintCandidate,
  StaleRunCandidate,
  StaleSprintCandidate,
} from '@src/business/housekeeping/scan-housekeeping.ts';
import { isoTimestamp, makeActiveSprint, makeDoneSprint, makeProject, projectId } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const GONE = projectId('01900000-0000-7000-8000-0000000000ff');

const orphanSprint = (sprint: Sprint, bytes = 100): OrphanSprintCandidate => ({
  kind: 'orphan-sprint',
  sprintId: sprint.id,
  projectId: GONE,
  name: sprint.name,
  status: sprint.status,
  ticketCount: 0,
  bytes,
});

const staleSprint = (sprint: Sprint, bytes = 50): StaleSprintCandidate => ({
  kind: 'stale-sprint',
  sprintId: sprint.id,
  projectId: sprint.projectId,
  name: sprint.name,
  doneAt: isoTimestamp('2026-01-01T00:00:00.000Z'),
  ticketCount: 0,
  bytes,
});

const orphanMemory = (id: string, bytes = 10): OrphanMemoryCandidate => ({
  kind: 'orphan-memory',
  projectId: id,
  name: `${id}--x`,
  bytes,
});

const staleRun = (runId: string, bytes = 5): StaleRunCandidate => ({
  kind: 'stale-run',
  flow: 'readiness',
  runId,
  startedAt: isoTimestamp('2026-01-01T00:00:00.000Z'),
  bytes,
});

interface Harness {
  readonly props: (candidates: PurgeHousekeepingProps['candidates']) => PurgeHousekeepingProps;
  readonly removedSprints: SprintId[];
  readonly removedMemory: string[];
  readonly removedRuns: string[];
}

const harness = (opts: {
  readonly projects?: readonly string[];
  readonly sprints?: readonly Sprint[];
  readonly failRun?: string;
  readonly runActive?: boolean;
}): Harness => {
  const projects = new Set(opts.projects ?? []);
  const sprints = new Map((opts.sprints ?? []).map((s) => [s.id, s]));
  const removedSprints: SprintId[] = [];
  const removedMemory: string[] = [];
  const removedRuns: string[] = [];
  return {
    removedSprints,
    removedMemory,
    removedRuns,
    props: (candidates) => ({
      candidates,
      logger: noopLogger,
      runActivity: { anyRunActive: async () => opts.runActive ?? false },
      projectRepo: {
        async findById(id) {
          return projects.has(id)
            ? Result.ok(makeProject({ id }))
            : Result.error(new NotFoundError({ entity: 'project', id }));
        },
      },
      sprintRepo: {
        async findById(id) {
          const s = sprints.get(id);
          return s ? Result.ok(s) : Result.error(new NotFoundError({ entity: 'sprint', id }));
        },
        async remove(id) {
          if (!sprints.delete(id)) return Result.error(new NotFoundError({ entity: 'sprint', id }));
          removedSprints.push(id);
          return Result.ok(undefined);
        },
      },
      disk: {
        async removeMemoryDirs(id) {
          removedMemory.push(id);
          return Result.ok(1);
        },
        async removeRunArtifact(run) {
          if (run.runId === opts.failRun) return Result.error(new StorageError({ subCode: 'io', message: 'EACCES' }));
          removedRuns.push(run.runId);
          return Result.ok(undefined);
        },
      },
    }),
  };
};

describe('purgeHousekeepingUseCase', () => {
  it('removes every kind of candidate and sums the freed bytes', async () => {
    const orphan = makeActiveSprint();
    const done = makeDoneSprint();
    const h = harness({ sprints: [orphan, done] });
    const r = await purgeHousekeepingUseCase(
      h.props([orphanSprint(orphan), staleSprint(done), orphanMemory(GONE), staleRun('r1')])
    );
    if (!r.ok) throw r.error;
    expect(r.value.removed).toHaveLength(4);
    expect(r.value.freedBytes).toBe(100 + 50 + 10 + 5);
    expect(h.removedSprints).toEqual([orphan.id, done.id]);
    expect(h.removedMemory).toEqual([GONE]);
    expect(h.removedRuns).toEqual(['r1']);
  });

  it('skips an orphan whose project exists again', async () => {
    const orphan = makeActiveSprint();
    const h = harness({ projects: [GONE], sprints: [orphan] });
    const r = await purgeHousekeepingUseCase(h.props([orphanSprint(orphan), orphanMemory(GONE)]));
    if (!r.ok) throw r.error;
    expect(r.value.removed).toEqual([]);
    expect(r.value.skipped.map((s) => s.candidate.kind)).toEqual(['orphan-sprint', 'orphan-memory']);
    expect(h.removedSprints).toEqual([]);
    expect(h.removedMemory).toEqual([]);
  });

  it('skips a stale sprint that is no longer done', async () => {
    const reopened = makeActiveSprint();
    const h = harness({ sprints: [reopened] });
    const r = await purgeHousekeepingUseCase(h.props([staleSprint(reopened)]));
    if (!r.ok) throw r.error;
    expect(r.value.skipped).toEqual([{ candidate: staleSprint(reopened), reason: 'sprint is active again' }]);
    expect(h.removedSprints).toEqual([]);
  });

  it('keeps going past a failure and reports it', async () => {
    const h = harness({ failRun: 'bad' });
    const r = await purgeHousekeepingUseCase(h.props([staleRun('bad'), staleRun('good')]));
    if (!r.ok) throw r.error;
    expect(r.value.failed).toEqual([{ candidate: staleRun('bad'), message: 'EACCES' }]);
    expect(r.value.removed).toEqual([staleRun('good')]);
    expect(r.value.freedBytes).toBe(5);
  });

  it('treats an already-deleted sprint as removed without counting its bytes', async () => {
    const done = makeDoneSprint();
    const h = harness({});
    const r = await purgeHousekeepingUseCase(h.props([staleSprint(done), staleSprint(done)]));
    if (!r.ok) throw r.error;
    expect(r.value.removed).toHaveLength(1);
    expect(r.value.freedBytes).toBe(0);
  });

  it('refuses while a flow is running and touches nothing', async () => {
    const orphan = makeActiveSprint();
    const h = harness({ sprints: [orphan], runActive: true });
    const r = await purgeHousekeepingUseCase(h.props([orphanSprint(orphan), orphanMemory(GONE), staleRun('r1')]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(InvalidStateError);
      expect(r.error.message).toBe('A flow is running — let it finish (or cancel it) before removing data.');
    }
    expect(h.removedSprints).toEqual([]);
    expect(h.removedMemory).toEqual([]);
    expect(h.removedRuns).toEqual([]);
  });
});
