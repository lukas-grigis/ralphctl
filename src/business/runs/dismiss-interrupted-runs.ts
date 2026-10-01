import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { LiveRunStore } from '@src/business/runs/live-run.ts';
import type { DetectInterruptedRuns } from '@src/business/runs/detect-interrupted-runs.ts';

export interface DismissInterruptedRunsDeps {
  readonly detect: DetectInterruptedRuns;
  readonly store: Pick<LiveRunStore, 'remove'>;
}

export interface DismissInterruptedRuns {
  /** Removes the named records that are still interrupted; a live run's record is never touched. Resolves the count. */
  execute(runIds: readonly string[]): Promise<Result<number, StorageError>>;
}

export const createDismissInterruptedRuns = (deps: DismissInterruptedRunsDeps): DismissInterruptedRuns => ({
  async execute(runIds) {
    if (runIds.length === 0) return Result.ok(0) as Result<number, StorageError>;
    const detected = await deps.detect.execute();
    if (!detected.ok) return Result.error(detected.error);
    const wanted = new Set(runIds);
    let removed = 0;
    for (const { record } of detected.value) {
      if (!wanted.has(record.runId)) continue;
      const result = await deps.store.remove(record.runId);
      if (!result.ok) return Result.error(result.error);
      removed += 1;
    }
    return Result.ok(removed) as Result<number, StorageError>;
  },
});
