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
 *
 * The attribution COUNTS come from `business/runs/outcome-stats.ts` so this surface and
 * `ralphctl runs stats` fold the same persisted field the same way. The tier ordering above is
 * local and deliberate — it is a presentation decision, not a metric, and stays here.
 */

import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt, VerifyRun } from '@src/domain/entity/attempt.ts';
import { foldTaskRollup } from '@src/business/runs/outcome-stats.ts';

/** Stale threshold for "baseline state may be out of date", in ms. */
const STALE_MS = 30 * 60 * 1000;

export type BaselineTier = 'green' | 'amber' | 'red' | 'unknown';

/** @public */
export interface BaselineHealth {
  readonly tier: BaselineTier;
  readonly label: string;
}

export interface AttributionCounts {
  readonly clean: number;
  readonly regressed: number;
  readonly fixedBaseline: number;
  readonly baselineBroken: number;
}

/**
 * The four attribution verdicts, in the camelCase shape the card renders. A thin projection of
 * the business fold's `attribution.byVerdict` — the counting itself is not duplicated here, so
 * this surface inherits its tolerant reads (a legacy task with no `attempts` array no longer
 * throws in the render path) and can never drift from the CLI rollup.
 */
export const countAttributions = (tasks: readonly Task[]): AttributionCounts => {
  const { byVerdict } = foldTaskRollup(tasks).attribution;
  return {
    clean: byVerdict.clean,
    regressed: byVerdict.regressed,
    fixedBaseline: byVerdict['fixed-baseline'],
    baselineBroken: byVerdict['baseline-broken'],
  };
};

/** Newer-wins fold of two verify rows for the same phase, keyed on `ranAt`. */
const newerVerifyRun = (current: VerifyRun | undefined, candidate: VerifyRun): VerifyRun =>
  current === undefined || candidate.ranAt > current.ranAt ? candidate : current;

/** The attempt history, or `[]` for a persisted task written before `attempts` existed. */
const attemptsOf = (task: Task): readonly Attempt[] => (Array.isArray(task.attempts) ? task.attempts : []);

/**
 * All verify rows across every attempt of a single task that match the given phase. Tolerant of a
 * legacy record — the same guarantee the business fold makes.
 */
const verifyRunsForPhase = (task: Task, phase: 'pre' | 'post'): readonly VerifyRun[] =>
  attemptsOf(task).flatMap((attempt) => (attempt?.verifyRuns ?? []).filter((row) => row.phase === phase));

/**
 * Walk every attempt across every task and return the most recent {@link VerifyRun} for the
 * given phase. Ordered by `ranAt`. Returns `undefined` when no row exists.
 */
export const latestVerifyRun = (tasks: readonly Task[], phase: 'pre' | 'post'): VerifyRun | undefined => {
  let latest: VerifyRun | undefined;
  for (const task of tasks) {
    for (const row of verifyRunsForPhase(task, phase)) {
      latest = newerVerifyRun(latest, row);
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

/** Hard red: a regression — the AI broke a previously-green baseline. Always wins. */
const regressionHealth = (counts: AttributionCounts): BaselineHealth | undefined =>
  counts.regressed > 0
    ? { tier: 'red', label: `red (${String(counts.regressed)} regression${counts.regressed === 1 ? '' : 's'})` }
    : undefined;

/**
 * Amber: broken-baseline attempts mean the red verify rows we'd otherwise blame are explained
 * by a pre-existing failure. Checked before the latest-row red probe so the baseline-broken
 * context wins over the raw red signal it contains.
 */
const brokenBaselineHealth = (counts: AttributionCounts): BaselineHealth | undefined =>
  counts.baselineBroken > 0 ? { tier: 'amber', label: `broken-base (${String(counts.baselineBroken)})` } : undefined;

/**
 * Latest-wins: only the LATEST pre + LATEST post row contribute. Historical reds on earlier
 * attempts are ignored — a red → green transition flips the tier to green.
 */
const latestRedHealth = (
  latestPre: VerifyRun | undefined,
  latestPost: VerifyRun | undefined
): BaselineHealth | undefined =>
  latestPre?.outcome === 'failed' || latestPost?.outcome === 'failed' ? { tier: 'red', label: 'red' } : undefined;

/** The most recent of the two verify-run timestamps, in epoch ms. */
const latestVerifyMs = (latestPre: VerifyRun | undefined, latestPost: VerifyRun | undefined): number | undefined => {
  const preMs = latestPre === undefined ? undefined : new Date(latestPre.ranAt).getTime();
  const postMs = latestPost === undefined ? undefined : new Date(latestPost.ranAt).getTime();
  if (preMs === undefined) return postMs;
  if (postMs === undefined) return preMs;
  return Math.max(preMs, postMs);
};

/** Stale: the most recent verify run was a long time ago — the baseline may have drifted. */
const staleHealth = (
  latestPre: VerifyRun | undefined,
  latestPost: VerifyRun | undefined,
  now: number
): BaselineHealth | undefined => {
  const latestMs = latestVerifyMs(latestPre, latestPost);
  return latestMs !== undefined && now - latestMs > STALE_MS ? { tier: 'amber', label: 'stale' } : undefined;
};

export const synthesiseBaselineHealth = ({ execution, tasks, now }: SynthesiseBaselineHealthInput): BaselineHealth => {
  const taskList = tasks ?? [];
  const counts = countAttributions(taskList);
  const setupHasRun = execution !== undefined && execution.setupRanAt.length > 0;
  const latestPre = latestVerifyRun(taskList, 'pre');
  const latestPost = latestVerifyRun(taskList, 'post');
  const anyVerifies = latestPre !== undefined || latestPost !== undefined;

  const decided =
    regressionHealth(counts) ??
    // Red setup is also a hard red — the working tree can't run, so any green verify is bogus.
    (anySetupRed(execution) ? { tier: 'red' as const, label: 'red' } : undefined) ??
    brokenBaselineHealth(counts) ??
    latestRedHealth(latestPre, latestPost) ??
    staleHealth(latestPre, latestPost, now);
  if (decided !== undefined) return decided;

  if (!setupHasRun && !anyVerifies) return { tier: 'unknown', label: 'awaiting first run' };
  return { tier: 'green', label: 'green' };
};
