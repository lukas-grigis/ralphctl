import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import {
  scanHousekeepingUseCase,
  type HousekeepingCandidate,
  type HousekeepingScan,
} from '@src/business/housekeeping/scan-housekeeping.ts';
import {
  purgeHousekeepingUseCase,
  type HousekeepingPurgeReport,
} from '@src/business/housekeeping/purge-housekeeping.ts';
import type { HousekeepingDeps } from '@src/application/flows/housekeeping/deps.ts';

/** View-facing housekeeping surface: a read-only scan, and a purge of candidates picked from it. */
export interface Housekeeping {
  scan(opts?: { readonly staleAfterDays?: number }): Promise<Result<HousekeepingScan, StorageError | ValidationError>>;
  purge(candidates: readonly HousekeepingCandidate[]): Promise<Result<HousekeepingPurgeReport, never>>;
}

export const createHousekeeping = (deps: HousekeepingDeps): Housekeeping => ({
  scan: (opts) =>
    scanHousekeepingUseCase({
      projectRepo: deps.projectRepo,
      sprintRepo: deps.sprintRepo,
      disk: deps.housekeepingDisk,
      now: deps.clock(),
      ...(opts?.staleAfterDays !== undefined ? { staleAfterDays: opts.staleAfterDays } : {}),
      logger: deps.logger,
    }),
  purge: (candidates) =>
    purgeHousekeepingUseCase({
      candidates,
      projectRepo: deps.projectRepo,
      sprintRepo: deps.sprintRepo,
      disk: deps.housekeepingDisk,
      logger: deps.logger,
    }),
});
