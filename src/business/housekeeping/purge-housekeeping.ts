import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { HousekeepingDisk } from '@src/business/housekeeping/housekeeping-disk.ts';
import {
  housekeepingCandidateKey,
  type HousekeepingCandidate,
  type OrphanMemoryCandidate,
  type OrphanSprintCandidate,
  type StaleRunCandidate,
  type StaleSprintCandidate,
} from '@src/business/housekeeping/scan-housekeeping.ts';

export interface PurgeSkip {
  readonly candidate: HousekeepingCandidate;
  readonly reason: string;
}

export interface PurgeFailure {
  readonly candidate: HousekeepingCandidate;
  readonly message: string;
}

export interface HousekeepingPurgeReport {
  readonly removed: readonly HousekeepingCandidate[];
  /** Candidates that no longer qualify (the project came back, the sprint was reopened). Left on disk. */
  readonly skipped: readonly PurgeSkip[];
  readonly failed: readonly PurgeFailure[];
  /** Bytes of the candidates actually deleted, as measured by the scan. */
  readonly freedBytes: number;
}

export interface PurgeHousekeepingProps {
  readonly candidates: readonly HousekeepingCandidate[];
  readonly projectRepo: FindById<Project, ProjectId>;
  readonly sprintRepo: FindById<Sprint, SprintId> & Remove<SprintId>;
  readonly disk: Pick<HousekeepingDisk, 'removeMemoryDirs' | 'removeRunArtifact'>;
  readonly logger: Logger;
}

type Outcome =
  | { readonly kind: 'removed'; readonly freed: number }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly message: string };

const removed = (freed: number): Outcome => ({ kind: 'removed', freed });
const skipped = (reason: string): Outcome => ({ kind: 'skipped', reason });
const failed = (message: string): Outcome => ({ kind: 'failed', message });

/** `true` when the project is gone; an outcome when it exists or the lookup itself failed. */
const projectIsGone = async (repo: PurgeHousekeepingProps['projectRepo'], rawId: string): Promise<true | Outcome> => {
  const parsed = ProjectId.parse(rawId);
  if (!parsed.ok) return true;
  const found = await repo.findById(parsed.value);
  if (found.ok) return skipped('its project exists again');
  return found.error instanceof NotFoundError ? true : failed(found.error.message);
};

const removeSprint = async (
  repo: PurgeHousekeepingProps['sprintRepo'],
  id: SprintId,
  bytes: number
): Promise<Outcome> => {
  const r = await repo.remove(id);
  if (r.ok) return removed(bytes);
  return r.error instanceof NotFoundError ? removed(0) : failed(r.error.message);
};

const purgeOrphanSprint = async (props: PurgeHousekeepingProps, c: OrphanSprintCandidate): Promise<Outcome> => {
  const gone = await projectIsGone(props.projectRepo, c.projectId);
  if (gone !== true) return gone;
  return removeSprint(props.sprintRepo, c.sprintId, c.bytes);
};

const purgeStaleSprint = async (props: PurgeHousekeepingProps, c: StaleSprintCandidate): Promise<Outcome> => {
  const current = await props.sprintRepo.findById(c.sprintId);
  if (!current.ok) return current.error instanceof NotFoundError ? removed(0) : failed(current.error.message);
  if (current.value.status !== 'done') return skipped(`sprint is ${current.value.status} again`);
  return removeSprint(props.sprintRepo, c.sprintId, c.bytes);
};

const purgeOrphanMemory = async (props: PurgeHousekeepingProps, c: OrphanMemoryCandidate): Promise<Outcome> => {
  const gone = await projectIsGone(props.projectRepo, c.projectId);
  if (gone !== true) return gone;
  const r = await props.disk.removeMemoryDirs(c.projectId);
  if (!r.ok) return failed(r.error.message);
  return removed(r.value > 0 ? c.bytes : 0);
};

const purgeStaleRun = async (props: PurgeHousekeepingProps, c: StaleRunCandidate): Promise<Outcome> => {
  const r = await props.disk.removeRunArtifact({ flow: c.flow, runId: c.runId });
  if (r.ok) return removed(c.bytes);
  return r.error instanceof NotFoundError ? removed(0) : failed(r.error.message);
};

const purgeOne = (props: PurgeHousekeepingProps, candidate: HousekeepingCandidate): Promise<Outcome> => {
  switch (candidate.kind) {
    case 'orphan-sprint':
      return purgeOrphanSprint(props, candidate);
    case 'stale-sprint':
      return purgeStaleSprint(props, candidate);
    case 'orphan-memory':
      return purgeOrphanMemory(props, candidate);
    case 'stale-run':
      return purgeStaleRun(props, candidate);
  }
};

/** Delete scanned housekeeping candidates. */
export const purgeHousekeepingUseCase = async (
  props: PurgeHousekeepingProps
): Promise<Result<HousekeepingPurgeReport, never>> => {
  const log = props.logger.named('housekeeping.purge');
  const seen = new Set<string>();
  const removedList: HousekeepingCandidate[] = [];
  const skippedList: PurgeSkip[] = [];
  const failedList: PurgeFailure[] = [];
  let freedBytes = 0;

  for (const candidate of props.candidates) {
    const key = housekeepingCandidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const outcome = await purgeOne(props, candidate);
    if (outcome.kind === 'removed') {
      removedList.push(candidate);
      freedBytes += outcome.freed;
    } else if (outcome.kind === 'skipped') {
      skippedList.push({ candidate, reason: outcome.reason });
    } else {
      log.warn('purge failed', { key, error: outcome.message });
      failedList.push({ candidate, message: outcome.message });
    }
  }

  log.info('purge complete', {
    removed: removedList.length,
    skipped: skippedList.length,
    failed: failedList.length,
    freedBytes,
  });
  return Result.ok({ removed: removedList, skipped: skippedList, failed: failedList, freedBytes });
};
