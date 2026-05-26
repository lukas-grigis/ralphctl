/**
 * Shared baseline-health predicate — the single source of truth for the verify-gate tier
 * that drives both {@link BaselineHealthChip} (one-line) and {@link BaselineHealthCard}
 * (four-row expanded). Co-locating the synthesis here is what keeps the two surfaces from
 * disagreeing after a red → green transition.
 *
 * Latest-wins semantics: only the most recent pre-verify row and the most recent post-verify
 * row contribute to the tier; historical reds on earlier attempts are ignored. Attribution
 * counts (regressed / baseline-broken) and the setup-script audit still drive hard-red /
 * amber states because those signals already capture the relevant history.
 *
 *  - `red`     — any regression, any red setup row, or the LATEST pre/post verify row is red
 *  - `amber`   — broken-baseline attempts OR every verify row is older than {@link STALE_MS}
 *  - `green`   — at least one signal has run and nothing is red / amber
 *  - `unknown` — no setup-script row, no verify-run row anywhere
 */

import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attribution, VerifyRun } from '@src/domain/entity/attempt.ts';

/** Stale threshold for "baseline state may be out of date", in ms. */
const STALE_MS = 30 * 60 * 1000;

/** @public */
export type BaselineTier = 'green' | 'amber' | 'red' | 'unknown';

/** @public */
export interface BaselineHealth {
  readonly tier: BaselineTier;
  readonly label: string;
}

/** @public */
export interface AttributionCounts {
  readonly clean: number;
  readonly regressed: number;
  readonly fixedBaseline: number;
  readonly baselineBroken: number;
}

/** @public */
export const countAttributions = (tasks: readonly Task[]): AttributionCounts => {
  let clean = 0;
  let regressed = 0;
  let fixedBaseline = 0;
  let baselineBroken = 0;
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      const a: Attribution | undefined = attempt.attribution;
      if (a === 'clean') clean++;
      else if (a === 'regressed') regressed++;
      else if (a === 'fixed-baseline') fixedBaseline++;
      else if (a === 'baseline-broken') baselineBroken++;
    }
  }
  return { clean, regressed, fixedBaseline, baselineBroken };
};

/**
 * Walk every attempt across every task and return the most recent {@link VerifyRun} for the
 * given phase. Ordered by `ranAt`. Returns `undefined` when no row exists.
 * @public
 */
export const latestVerifyRun = (tasks: readonly Task[], phase: 'pre' | 'post'): VerifyRun | undefined => {
  let latest: VerifyRun | undefined;
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      if (attempt.verifyRuns === undefined) continue;
      for (const row of attempt.verifyRuns) {
        if (row.phase !== phase) continue;
        if (latest === undefined || row.ranAt > latest.ranAt) latest = row;
      }
    }
  }
  return latest;
};

const anySetupRed = (execution: SprintExecution | undefined): boolean => {
  if (execution === undefined) return false;
  // Reduce-by-repo: a later success overwrites an earlier failure.
  const byRepo = new Map<string, string>();
  for (const row of execution.setupRanAt) byRepo.set(String(row.repositoryId), row.outcome);
  for (const v of byRepo.values()) {
    if (v === 'failed' || v === 'spawn-error') return true;
  }
  return false;
};

/** @public */
export interface SynthesiseBaselineHealthInput {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  /** Wall-clock `Date.now()` value used for the stale-threshold comparison. */
  readonly now: number;
}

/** @public */
export const synthesiseBaselineHealth = ({ execution, tasks, now }: SynthesiseBaselineHealthInput): BaselineHealth => {
  const taskList = tasks ?? [];
  const counts = countAttributions(taskList);
  const setupHasRun = execution !== undefined && execution.setupRanAt.length > 0;
  const latestPre = latestVerifyRun(taskList, 'pre');
  const latestPost = latestVerifyRun(taskList, 'post');
  const anyVerifies = latestPre !== undefined || latestPost !== undefined;

  // Hard red: a regression — the AI broke a previously-green baseline. Always wins.
  if (counts.regressed > 0) {
    return {
      tier: 'red',
      label: `red (${String(counts.regressed)} regression${counts.regressed === 1 ? '' : 's'})`,
    };
  }
  // Red setup is also a hard red — the working tree can't run, so any green verify is bogus.
  if (anySetupRed(execution)) {
    return { tier: 'red', label: 'red' };
  }

  // Amber: broken-baseline attempts mean the red verify rows we'd otherwise blame are
  // explained by a pre-existing failure. Check this BEFORE the latest-row red probe so the
  // baseline-broken context wins over the raw red signal it contains.
  if (counts.baselineBroken > 0) {
    return { tier: 'amber', label: `broken-base (${String(counts.baselineBroken)})` };
  }

  // Latest-wins: only the LATEST pre + LATEST post row contribute. Historical reds on
  // earlier attempts are ignored — a red → green transition flips the tier to green.
  if (latestPre?.outcome === 'failed' || latestPost?.outcome === 'failed') {
    return { tier: 'red', label: 'red' };
  }

  // Stale: the most recent verify run was a long time ago — the baseline may have drifted.
  let latestMs: number | undefined;
  if (latestPre !== undefined) latestMs = new Date(latestPre.ranAt).getTime();
  if (latestPost !== undefined) {
    const t = new Date(latestPost.ranAt).getTime();
    if (latestMs === undefined || t > latestMs) latestMs = t;
  }
  if (latestMs !== undefined && now - latestMs > STALE_MS) {
    return { tier: 'amber', label: 'stale' };
  }

  if (!setupHasRun && !anyVerifies) return { tier: 'unknown', label: 'awaiting first run' };
  return { tier: 'green', label: 'green' };
};
