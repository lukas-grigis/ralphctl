import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { HousekeepingDisk } from '@src/business/housekeeping/housekeeping-disk.ts';

export const DEFAULT_STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sprint whose project no longer exists. */
export interface OrphanSprintCandidate {
  readonly kind: 'orphan-sprint';
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly status: SprintStatus;
  readonly ticketCount: number;
  readonly bytes: number;
}

/** A done sprint sealed longer ago than the stale threshold. */
export interface StaleSprintCandidate {
  readonly kind: 'stale-sprint';
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly doneAt: IsoTimestamp;
  readonly ticketCount: number;
  readonly bytes: number;
}

/** A memory dir whose project no longer exists. */
export interface OrphanMemoryCandidate {
  readonly kind: 'orphan-memory';
  readonly projectId: string;
  readonly name: string;
  readonly bytes: number;
}

/** A run artifact older than the stale threshold. */
export interface StaleRunCandidate {
  readonly kind: 'stale-run';
  readonly flow: string;
  readonly runId: string;
  readonly startedAt: IsoTimestamp;
  readonly bytes: number;
}

export type HousekeepingCandidate =
  OrphanSprintCandidate | StaleSprintCandidate | OrphanMemoryCandidate | StaleRunCandidate;

export interface RunArtifactTotals {
  readonly count: number;
  readonly bytes: number;
}

export interface HousekeepingScan {
  readonly staleAfterDays: number;
  readonly orphanSprints: readonly OrphanSprintCandidate[];
  readonly orphanMemoryDirs: readonly OrphanMemoryCandidate[];
  readonly staleDoneSprints: readonly StaleSprintCandidate[];
  readonly staleRuns: readonly StaleRunCandidate[];
  /** Every run artifact on disk, stale or not. */
  readonly runTotals: RunArtifactTotals;
  /** Sum of every candidate group above. */
  readonly reclaimableBytes: number;
}

export interface ScanHousekeepingProps {
  readonly projectRepo: ListAll<Project>;
  readonly sprintRepo: ListAll<Sprint>;
  readonly disk: Pick<HousekeepingDisk, 'sprintBytes' | 'listMemoryDirs' | 'listRunArtifacts'>;
  readonly now: IsoTimestamp;
  readonly staleAfterDays?: number;
  readonly logger: Logger;
}

/** Stable identity for a candidate — the multi-select key and the purge dedup key. */
export const housekeepingCandidateKey = (candidate: HousekeepingCandidate): string => {
  switch (candidate.kind) {
    case 'orphan-sprint':
    case 'stale-sprint':
      return `sprint:${candidate.sprintId}`;
    case 'orphan-memory':
      return `memory:${candidate.projectId}`;
    case 'stale-run':
      return `run:${candidate.flow}/${candidate.runId}`;
  }
};

const sumBytes = (candidates: ReadonlyArray<{ readonly bytes: number }>): number =>
  candidates.reduce((acc, c) => acc + c.bytes, 0);

const isOlderThan = (stamp: string, nowMs: number, thresholdMs: number): boolean => {
  const at = Date.parse(stamp);
  return Number.isFinite(at) && nowMs - at >= thresholdMs;
};

const byOldest =
  <T>(stamp: (c: T) => string) =>
  (a: T, b: T): number =>
    Date.parse(stamp(a)) - Date.parse(stamp(b));

const classifySprints = async (
  sprints: readonly Sprint[],
  projectIds: ReadonlySet<string>,
  disk: ScanHousekeepingProps['disk'],
  nowMs: number,
  thresholdMs: number
): Promise<{ orphans: OrphanSprintCandidate[]; stale: StaleSprintCandidate[] }> => {
  const orphans: OrphanSprintCandidate[] = [];
  const stale: StaleSprintCandidate[] = [];
  for (const sprint of sprints) {
    const common = { sprintId: sprint.id, projectId: sprint.projectId, name: sprint.name };
    if (!projectIds.has(sprint.projectId)) {
      const bytes = await disk.sprintBytes(sprint.id);
      orphans.push({
        kind: 'orphan-sprint',
        ...common,
        status: sprint.status,
        ticketCount: sprint.tickets.length,
        bytes,
      });
      continue;
    }
    if (sprint.status === 'done' && isOlderThan(sprint.doneAt, nowMs, thresholdMs)) {
      const bytes = await disk.sprintBytes(sprint.id);
      stale.push({ kind: 'stale-sprint', ...common, doneAt: sprint.doneAt, ticketCount: sprint.tickets.length, bytes });
    }
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));
  stale.sort(byOldest((c) => c.doneAt));
  return { orphans, stale };
};

/**
 * Dry-run inventory of what can be reclaimed under the data root: orphan sprints and memory dirs (their project is
 * gone), done sprints and run artifacts older than `staleAfterDays`.
 */
export const scanHousekeepingUseCase = async (
  props: ScanHousekeepingProps
): Promise<Result<HousekeepingScan, StorageError | ValidationError>> => {
  const log = props.logger.named('housekeeping.scan');
  const staleAfterDays = props.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  if (!Number.isFinite(staleAfterDays) || staleAfterDays < 0) {
    return Result.error(
      new ValidationError({
        field: 'staleAfterDays',
        value: staleAfterDays,
        message: 'stale threshold must be a non-negative number of days',
      })
    );
  }
  const thresholdMs = staleAfterDays * DAY_MS;
  const nowMs = Date.parse(props.now);

  const projects = await props.projectRepo.list();
  if (!projects.ok) return Result.error(projects.error);
  const sprints = await props.sprintRepo.list();
  if (!sprints.ok) return Result.error(sprints.error);
  const memoryDirs = await props.disk.listMemoryDirs();
  if (!memoryDirs.ok) return Result.error(memoryDirs.error);
  const runs = await props.disk.listRunArtifacts();
  if (!runs.ok) return Result.error(runs.error);

  const projectIds = new Set<string>(projects.value.map((p) => p.id));
  const { orphans, stale } = await classifySprints(sprints.value, projectIds, props.disk, nowMs, thresholdMs);

  const orphanMemoryDirs: OrphanMemoryCandidate[] = memoryDirs.value
    .filter((dir) => !projectIds.has(dir.projectId))
    .map((dir) => ({ kind: 'orphan-memory', projectId: dir.projectId, name: dir.name, bytes: dir.bytes }));
  orphanMemoryDirs.sort((a, b) => a.name.localeCompare(b.name));

  const staleRuns: StaleRunCandidate[] = [];
  for (const run of runs.value) {
    if (run.startedAt === null || !isOlderThan(run.startedAt, nowMs, thresholdMs)) continue;
    staleRuns.push({ kind: 'stale-run', flow: run.flow, runId: run.runId, startedAt: run.startedAt, bytes: run.bytes });
  }
  staleRuns.sort(byOldest((c) => c.startedAt));

  const scan: HousekeepingScan = {
    staleAfterDays,
    orphanSprints: orphans,
    orphanMemoryDirs,
    staleDoneSprints: stale,
    staleRuns,
    runTotals: { count: runs.value.length, bytes: sumBytes(runs.value) },
    reclaimableBytes: sumBytes(orphans) + sumBytes(orphanMemoryDirs) + sumBytes(stale) + sumBytes(staleRuns),
  };
  log.debug('scan complete', {
    orphanSprints: orphans.length,
    orphanMemoryDirs: orphanMemoryDirs.length,
    staleDoneSprints: stale.length,
    staleRuns: staleRuns.length,
    reclaimableBytes: scan.reclaimableBytes,
  });
  return Result.ok(scan);
};
