/**
 * Baseline-Health Chip — single-line companion to the right-context {@link BaselineHealthCard}.
 *
 * Renders above the active-task header so the verify-gate state is visible without scrolling.
 * Three states (colour is the load-bearing signal; glyphs / words are the fallback for
 * monochrome / colour-blind operators):
 *
 *  - `green` — every verify run seen so far has passed; no regressions.
 *  - `amber` — pre-verify showed a stale baseline (last run > N minutes ago) OR the latest
 *               attempt landed on a broken baseline (`attribution: 'baseline-broken'`).
 *  - `red`   — any regression or red post-verify; the AI broke a previously-green baseline.
 *
 * State source mirrors the card — derives from the same `SprintExecution.setupRanAt` +
 * `Task.attempts[].verifyRuns` data, kept in this one place so card + chip never disagree.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { VerifyRun } from '@src/domain/entity/attempt.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { countAttributions } from '@src/application/ui/tui/components/baseline-health-card.tsx';

/** Stale threshold for the "baseline state may be out of date" warning, in ms. */
const STALE_MS = 30 * 60 * 1000;

type Tier = 'green' | 'amber' | 'red' | 'unknown';

const latestVerifyTimestamp = (tasks: readonly Task[]): number | undefined => {
  let latestMs: number | undefined;
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      if (attempt.verifyRuns === undefined) continue;
      for (const row of attempt.verifyRuns) {
        const ms = new Date(row.ranAt).getTime();
        if (latestMs === undefined || ms > latestMs) latestMs = ms;
      }
    }
  }
  return latestMs;
};

const anyRedVerify = (tasks: readonly Task[]): boolean => {
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      if (attempt.verifyRuns === undefined) continue;
      for (const row of attempt.verifyRuns) {
        if (row.outcome === 'failed') return true;
      }
    }
  }
  return false;
};

const anySetupRed = (execution: SprintExecution | undefined): boolean => {
  if (execution === undefined) return false;
  // Reduce-by-repo: a later success overwrites an earlier failure.
  const byRepo = new Map<string, VerifyRun['outcome'] | 'success' | 'failed' | 'spawn-error' | 'skipped'>();
  for (const row of execution.setupRanAt) byRepo.set(String(row.repositoryId), row.outcome);
  for (const v of byRepo.values()) {
    if (v === 'failed' || v === 'spawn-error') return true;
  }
  return false;
};

const synthesise = (
  execution: SprintExecution | undefined,
  tasks: readonly Task[],
  now: number
): { tier: Tier; label: string } => {
  const counts = countAttributions(tasks);
  const anyVerifies = latestVerifyTimestamp(tasks) !== undefined;
  const setupHasRun = execution !== undefined && execution.setupRanAt.length > 0;

  // Hard red: a regression — the AI broke a previously-green baseline. Always wins.
  if (counts.regressed > 0) {
    return { tier: 'red', label: `red (${String(counts.regressed)} regression${counts.regressed === 1 ? '' : 's'})` };
  }
  // Red setup is also a hard red — the working tree can't run, so any green verify is bogus.
  if (anySetupRed(execution)) {
    return { tier: 'red', label: 'red' };
  }

  // Amber: broken-baseline attempts mean the red VerifyRuns we'd otherwise blame are explained
  // by a pre-existing failure. Surface as amber (warning) rather than red so the operator knows
  // it's a known-state, not "the harness is on fire". Check this BEFORE `anyRedVerify` so the
  // baseline-broken context wins over the raw red-verify signal it contains.
  if (counts.baselineBroken > 0) {
    return { tier: 'amber', label: `broken-base (${String(counts.baselineBroken)})` };
  }
  if (anyRedVerify(tasks)) {
    return { tier: 'red', label: 'red' };
  }

  // Stale: the most recent verify run was a long time ago — the baseline state may have drifted.
  const latest = latestVerifyTimestamp(tasks);
  if (latest !== undefined && now - latest > STALE_MS) {
    return { tier: 'amber', label: 'stale' };
  }

  if (!setupHasRun && !anyVerifies) return { tier: 'unknown', label: 'awaiting first run' };
  return { tier: 'green', label: 'green' };
};

const tierColor = (tier: Tier): string => {
  if (tier === 'green') return inkColors.success;
  if (tier === 'amber') return inkColors.warning;
  if (tier === 'red') return inkColors.error;
  return inkColors.muted;
};

const tierGlyph = (tier: Tier): string => {
  if (tier === 'green') return glyphs.check;
  if (tier === 'amber') return glyphs.warningGlyph;
  if (tier === 'red') return glyphs.cross;
  return glyphs.phasePending;
};

/** @public */
export interface BaselineHealthChipProps {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  readonly now?: number;
}

/** @public */
export const BaselineHealthChip = ({ execution, tasks, now }: BaselineHealthChipProps): React.JSX.Element => {
  const summary = synthesise(execution, tasks ?? [], now ?? Date.now());
  return (
    <Box>
      <Text dimColor>baseline </Text>
      <Text color={tierColor(summary.tier)} bold>
        {tierGlyph(summary.tier)} {summary.label}
      </Text>
    </Box>
  );
};
