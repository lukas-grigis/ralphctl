import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  sameIdentity,
  type LiveRunSpawn,
  type LiveRunStore,
  type ProcessGroupTerminator,
  type ProcessLiveness,
} from '@src/business/runs/live-run.ts';
import type { DetectInterruptedRuns } from '@src/business/runs/detect-interrupted-runs.ts';

export interface ReapInterruptedRunsOutput {
  /** Interrupted runs handled by this pass. */
  readonly runIds: readonly string[];
  /** Process groups that were signalled. */
  readonly reapedGroups: readonly number[];
}

export interface ReapInterruptedRunsDeps {
  readonly detect: DetectInterruptedRuns;
  readonly store: Pick<LiveRunStore, 'save'>;
  readonly liveness: ProcessLiveness;
  readonly terminator: ProcessGroupTerminator;
  readonly now: () => string;
  readonly logger: Logger;
}

/**
 * Whether `spawn`'s process group is still ours to kill. A live group whose leader is gone can only
 * be the original group: a pid is never reused while a process group of that id exists. A live
 * leader must still be the recorded process — same start time and command — or the pid was recycled.
 */
const ownedGroup = async (spawn: LiveRunSpawn, liveness: ProcessLiveness): Promise<number | undefined> => {
  const pgid = spawn.pgid;
  if (pgid === undefined || !liveness.isGroupAlive(pgid)) return undefined;
  if (!liveness.isAlive(pgid)) return pgid;
  return sameIdentity(await liveness.identify(pgid), spawn.identity) ? pgid : undefined;
};

/**
 * Boot-time fallback for the orphan reaper: kill the AI CLI process groups that interrupted runs
 * left behind (the reaper sidecar failed, or the platform has none), then stamp each record so it is
 * not reaped twice. The records stay for crash recovery to read.
 */
export interface ReapInterruptedRuns {
  execute(): Promise<Result<ReapInterruptedRunsOutput, StorageError>>;
}

export const createReapInterruptedRuns = (deps: ReapInterruptedRunsDeps): ReapInterruptedRuns => ({
  async execute() {
    const detected = await deps.detect.execute();
    if (!detected.ok) return Result.error(detected.error);
    const runIds: string[] = [];
    const reapedGroups: number[] = [];
    for (const { record, liveSpawns } of detected.value) {
      if (record.reapedAt !== undefined) continue;
      for (const spawn of liveSpawns) {
        const pgid = await ownedGroup(spawn, deps.liveness);
        if (pgid === undefined) continue;
        deps.terminator.terminateGroup(pgid);
        reapedGroups.push(pgid);
      }
      const saved = await deps.store.save({ ...record, reapedAt: deps.now() });
      if (!saved.ok) deps.logger.warn('live-run: could not stamp a reaped record', { runId: record.runId });
      runIds.push(record.runId);
    }
    if (reapedGroups.length > 0) {
      deps.logger.info('live-run: reaped AI CLI process groups left by interrupted runs', {
        groups: reapedGroups.join(','),
      });
    }
    return Result.ok({ runIds, reapedGroups }) as Result<ReapInterruptedRunsOutput, StorageError>;
  },
});
