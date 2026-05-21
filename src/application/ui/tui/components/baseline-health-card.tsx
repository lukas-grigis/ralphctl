/**
 * Baseline-Health Card — surfaces the deterministic verify gate data the harness captures per
 * implement run, in the right-hand context column of the implement dashboard.
 *
 * Four signals collapse onto one card:
 *
 *  - `Setup`          — latest harness-side setup-script row per affected repo
 *                       (`SprintExecution.setupRanAt[last]`).
 *  - `Verify (pre)`   — most recent pre-task-verify row across every running/settled attempt.
 *  - `Verify (post)`  — most recent post-task-verify row.
 *  - `Attribution`    — count of `clean` / `regressed` / `fixed-baseline` / `baseline-broken`
 *                       verdicts across the sprint's attempts.
 *
 * The card aggregates data from the sources rather than depending on the (not-yet-wired)
 * `SprintState` projection. Once P1c wires `projectSprintState` into the TUI we can swap to
 * reading directly off that — for now we derive in-place from the entities the dashboard
 * already has access to.
 *
 * Renders `EmptyState`-style copy when no setup or verify has run yet (fresh sprint, first
 * launch). The chip variant in {@link BaselineHealthChip} is the single-line companion that
 * sits next to the breadcrumb.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { SetupRun, SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Attribution, VerifyRun } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { CONTEXT_WIDTH, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

/** Visual tier driven by status — maps to the existing semantic-state tokens. */
type Tier = 'green' | 'amber' | 'red' | 'unknown';

interface RowSummary {
  readonly tier: Tier;
  readonly label: string;
  readonly detail?: string;
}

/** @public */
export interface AttributionCounts {
  readonly clean: number;
  readonly regressed: number;
  readonly fixedBaseline: number;
  readonly baselineBroken: number;
}

/** @public */
export interface BaselineHealthCardProps {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  /** Required for the "Xm ago" labels — falls back to `Date.now()` if absent. */
  readonly now?: number;
}

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

const TierIcon = ({ tier }: { readonly tier: Tier }): React.JSX.Element => (
  <Text color={tierColor(tier)}>{tierGlyph(tier)}</Text>
);

/**
 * Latest-row-per-repo from `SetupRun[]`. The audit array is append-only, so the LAST entry
 * for a given repo is its current state.
 */
const latestSetupPerRepo = (rows: readonly SetupRun[]): readonly SetupRun[] => {
  const byRepo = new Map<string, SetupRun>();
  for (const row of rows) byRepo.set(String(row.repositoryId), row);
  return [...byRepo.values()];
};

const setupTier = (rows: readonly SetupRun[]): Tier => {
  if (rows.length === 0) return 'unknown';
  let hasFailed = false;
  let hasSpawnError = false;
  let allSkipped = true;
  for (const row of rows) {
    if (row.outcome !== 'skipped') allSkipped = false;
    if (row.outcome === 'failed') hasFailed = true;
    if (row.outcome === 'spawn-error') hasSpawnError = true;
  }
  if (hasFailed || hasSpawnError) return 'red';
  if (allSkipped) return 'unknown';
  return 'green';
};

const setupSummary = (execution: SprintExecution | undefined, now: number): RowSummary => {
  if (execution === undefined || execution.setupRanAt.length === 0) {
    return { tier: 'unknown', label: 'no setup run yet' };
  }
  const latest = latestSetupPerRepo(execution.setupRanAt);
  const tier = setupTier(latest);
  const newestTs = latest.reduce<string>(
    (max, r) => ((r.ranAt as string) > max ? (r.ranAt as string) : max),
    (latest[0]?.ranAt as string | undefined) ?? ''
  );
  const ago = newestTs !== '' ? fmtElapsed(new Date(newestTs).getTime(), now) : '?';
  if (tier === 'green') return { tier, label: 'green', detail: `${ago} ago` };
  if (tier === 'red') {
    const reds = latest.filter((r) => r.outcome === 'failed' || r.outcome === 'spawn-error').length;
    return { tier, label: `red (${String(reds)} repo${reds === 1 ? '' : 's'})`, detail: `${ago} ago` };
  }
  return { tier, label: 'skipped (no script)', detail: `${ago} ago` };
};

/**
 * Walk every attempt across every task and return the most recent {@link VerifyRun} for the
 * given phase. Ordered by `ranAt`. Returns `undefined` when no row exists.
 */
const latestVerifyRun = (tasks: readonly Task[], phase: 'pre' | 'post'): VerifyRun | undefined => {
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

const verifyRowSummary = (run: VerifyRun | undefined, now: number, phaseLabel: string): RowSummary => {
  if (run === undefined) return { tier: 'unknown', label: `no ${phaseLabel} verify yet` };
  const ago = fmtElapsed(new Date(run.ranAt).getTime(), now);
  if (run.outcome === 'success') return { tier: 'green', label: 'green', detail: `${ago} ago` };
  if (run.outcome === 'failed')
    return { tier: 'red', label: `red (exit=${String(run.exitCode)})`, detail: `${ago} ago` };
  if (run.outcome === 'spawn-error') return { tier: 'amber', label: 'spawn-error', detail: `${ago} ago` };
  return { tier: 'unknown', label: 'skipped', detail: `${ago} ago` };
};

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
 * Synthesise the overall card tone:
 *  - any `red` row → `error`
 *  - any `amber` row → `warning`
 *  - all-green → `success`
 *  - everything `unknown` → muted `rule`
 */
const cardTone = (rows: readonly RowSummary[]): 'success' | 'warning' | 'error' | 'rule' => {
  if (rows.some((r) => r.tier === 'red')) return 'error';
  if (rows.some((r) => r.tier === 'amber')) return 'warning';
  if (rows.some((r) => r.tier === 'green')) return 'success';
  return 'rule';
};

const Row = ({ label, summary }: { readonly label: string; readonly summary: RowSummary }): React.JSX.Element => (
  <Box>
    <Box marginRight={1}>
      <TierIcon tier={summary.tier} />
    </Box>
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{label} </Text>
        <Text color={tierColor(summary.tier)}>{summary.label}</Text>
      </Box>
      {summary.detail !== undefined && (
        <Box>
          <Text dimColor>{summary.detail}</Text>
        </Box>
      )}
    </Box>
  </Box>
);

/** @public */
export const BaselineHealthCard = ({ execution, tasks, now }: BaselineHealthCardProps): React.JSX.Element => {
  const tNow = now ?? Date.now();
  const taskList = tasks ?? [];

  const setup = useMemo(() => setupSummary(execution, tNow), [execution, tNow]);
  const preRow = useMemo(() => latestVerifyRun(taskList, 'pre'), [taskList]);
  const postRow = useMemo(() => latestVerifyRun(taskList, 'post'), [taskList]);
  const preSummary = verifyRowSummary(preRow, tNow, 'pre');
  const postSummary = verifyRowSummary(postRow, tNow, 'post');
  const counts = useMemo(() => countAttributions(taskList), [taskList]);

  const tone = cardTone([setup, preSummary, postSummary]);
  const isEmpty =
    setup.tier === 'unknown' &&
    preSummary.tier === 'unknown' &&
    postSummary.tier === 'unknown' &&
    counts.clean + counts.regressed + counts.fixedBaseline + counts.baselineBroken === 0;

  return (
    <Box width={CONTEXT_WIDTH} flexDirection="column">
      <Card title="Baseline" tone={tone}>
        {isEmpty ? (
          <Box paddingY={0}>
            <Text dimColor italic>
              awaiting first run…
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Row label="Setup" summary={setup} />
            <Box marginTop={spacing.gutter}>
              <Row label="Pre" summary={preSummary} />
            </Box>
            <Box marginTop={spacing.gutter}>
              <Row label="Post" summary={postSummary} />
            </Box>
            <Box marginTop={spacing.gutter} flexDirection="column">
              <Text dimColor>Attribution</Text>
              <Box>
                <Text color={inkColors.success}>
                  {glyphs.check} {String(counts.clean)} clean
                </Text>
              </Box>
              {counts.regressed > 0 && (
                <Box>
                  <Text color={inkColors.error}>
                    {glyphs.cross} {String(counts.regressed)} regressed
                  </Text>
                </Box>
              )}
              {counts.fixedBaseline > 0 && (
                <Box>
                  <Text color={inkColors.info}>
                    {glyphs.arrowRight} {String(counts.fixedBaseline)} fixed
                  </Text>
                </Box>
              )}
              {counts.baselineBroken > 0 && (
                <Box>
                  <Text color={inkColors.warning}>
                    {glyphs.warningGlyph} {String(counts.baselineBroken)} broken-base
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Card>
    </Box>
  );
};
