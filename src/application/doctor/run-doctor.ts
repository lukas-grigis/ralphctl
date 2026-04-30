/**
 * `runDoctor` — environment health snapshot.
 *
 * Executes every check in parallel where it's safe, aggregates the
 * results, and returns a `DoctorReport` the caller renders. The doctor
 * is **not** a chain — it has no business semantics, no rollback, and
 * no flow control. Chains exist for user-driven workflows; the doctor
 * is a one-off probe.
 *
 * Aggregate status:
 *  - Any `fail`             → `fail`
 *  - Any `warn` (and no fail) → `warn`
 *  - Otherwise (all pass / skip) → `ok`
 *
 * Each check is its own async function under `./checks/`. They depend
 * on whatever subset of `SharedDeps` they need (most pull `external`,
 * `configStore`, or `projectRepo`); the doctor passes through `deps`
 * unchanged.
 */
import type { SharedDeps } from '../bootstrap/shared-deps.ts';
import { aiProviderInstalledCheck } from './checks/ai-provider-installed.ts';
import { currentSprintReadableCheck } from './checks/current-sprint-readable.ts';
import { dataDirWritableCheck } from './checks/data-dir-writable.ts';
import { gitIdentityCheck } from './checks/git-identity.ts';
import { gitInstalledCheck } from './checks/git-installed.ts';
import { nodeVersionCheck } from './checks/node-version.ts';
import { onboardingStatusCheck } from './checks/onboarding-status.ts';
import { projectPathsExistCheck } from './checks/project-paths-exist.ts';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly message?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheckResult[];
  readonly status: 'ok' | 'warn' | 'fail';
}

/** Aggregate per-check statuses into the report-level rollup. */
export function aggregateStatus(checks: readonly DoctorCheckResult[]): DoctorReport['status'] {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

export async function runDoctor(deps: SharedDeps): Promise<DoctorReport> {
  // Each check is independent — fan out and gather. `Promise.all`
  // preserves order so the rendered report has a stable layout.
  const checks = await Promise.all([
    nodeVersionCheck(),
    gitInstalledCheck(),
    gitIdentityCheck(),
    aiProviderInstalledCheck({ configStore: deps.configStore }),
    dataDirWritableCheck({ storage: deps.storage }),
    projectPathsExistCheck({ projectRepo: deps.projectRepo }),
    onboardingStatusCheck({ projectRepo: deps.projectRepo }),
    currentSprintReadableCheck({
      configStore: deps.configStore,
      sprintRepo: deps.sprintRepo,
    }),
  ]);

  return {
    checks,
    status: aggregateStatus(checks),
  };
}
