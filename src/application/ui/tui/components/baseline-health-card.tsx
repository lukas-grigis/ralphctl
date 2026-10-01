/**
 * Baseline-Health Card — surfaces the deterministic verify gate data the harness captures per implement run, in the
 * right-hand context column of the implement dashboard.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { SetupRun, SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { VerifyRun } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { CONTEXT_WIDTH, type Tone, tones } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import {
  type AttributionCounts,
  type BaselineTier,
  countAttributions,
  latestVerifyRun,
  synthesiseBaselineHealth,
} from '@src/application/ui/tui/components/baseline-health.ts';

/**
 * Visual tier driven by status — maps to the existing semantic-state tokens. `ok` / `warning` / `error` mirror the
 * Card tone vocabulary; `pending` covers not-yet-run.
 */
type Tier = 'ok' | 'warning' | 'error' | 'pending';

/** Shared `outcome` discriminant for setup + verify runs that spawn a child process. */
const SPAWN_ERROR_OUTCOME = 'spawn-error';

/** @public */
export interface BaselineHealthCardProps {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  /** Required for the "Xm ago" labels — falls back to `Date.now()` if absent. */
  readonly now?: number;
  /** Card width in columns. Defaults to `CONTEXT_WIDTH` (28). */
  readonly width?: number;
}

const TIER_TONE: Readonly<Record<Tier, Tone>> = { ok: 'success', warning: 'warning', error: 'error', pending: 'muted' };

// Data model for a single indicator row

interface RowData {
  /**
   * Display label for the indicator (e.g. "Setup", "Pre-task"). Keep under ~14 chars so it never wraps at
   * CONTEXT_WIDTH (28 cols).
   */
  readonly label: string;
  /** Visual tier drives glyph + color. */
  readonly tier: Tier;
  /**
   * Short status phrase shown inline after the label (e.g. "failed", "not run yet"). For `error`/`warning`/`pending`
   * rows this is the primary detail token.
   */
  readonly status?: string;
  /**
   * Secondary detail tokens — elapsed time, count, repo name, etc. For `ok` rows the first entry is shown inline; for
   * other tiers `status` takes priority.
   */
  readonly sublines?: readonly string[];
}

/**
 * Latest-row-per-repo from `SetupRun[]`. The audit array is append-only, so the LAST entry for a given repo is its
 * current state.
 */
const latestSetupPerRepo = (rows: readonly SetupRun[]): readonly SetupRun[] => {
  const byRepo = new Map<string, SetupRun>();
  for (const row of rows) byRepo.set(String(row.repositoryId), row);
  return [...byRepo.values()];
};

const setupTier = (rows: readonly SetupRun[]): Tier => {
  if (rows.length === 0) return 'pending';
  let hasFailed = false;
  let hasSpawnError = false;
  let allSkipped = true;
  for (const row of rows) {
    if (row.outcome !== 'skipped') allSkipped = false;
    if (row.outcome === 'failed') hasFailed = true;
    if (row.outcome === SPAWN_ERROR_OUTCOME) hasSpawnError = true;
  }
  if (hasFailed || hasSpawnError) return 'error';
  if (allSkipped) return 'pending';
  return 'ok';
};

const setupRowData = (execution: SprintExecution | undefined, now: number): RowData => {
  if (execution === undefined || execution.setupRanAt.length === 0) {
    return { label: 'Setup', tier: 'pending', status: 'not run yet' };
  }
  const latest = latestSetupPerRepo(execution.setupRanAt);
  const tier = setupTier(latest);
  const newestTs = latest.reduce<string>(
    (max, r) => ((r.ranAt as string) > max ? (r.ranAt as string) : max),
    (latest[0]?.ranAt as string | undefined) ?? ''
  );
  const ago = newestTs !== '' ? fmtElapsed(new Date(newestTs).getTime(), now) : '?';
  const repoCount = latest.length;
  const repoLabel = `${String(repoCount)} repo${repoCount === 1 ? '' : 's'}`;

  if (tier === 'ok') {
    return { label: 'Setup', tier, sublines: [`${repoLabel} · ${ago} ago`] };
  }
  if (tier === 'error') {
    const failedCount = latest.filter((r) => r.outcome === 'failed' || r.outcome === SPAWN_ERROR_OUTCOME).length;
    return {
      label: 'Setup',
      tier,
      status: 'failed',
      sublines: [`${String(failedCount)} of ${repoLabel} · ${ago} ago`],
    };
  }
  // skipped / pending
  return { label: 'Setup', tier: 'pending', status: 'no script', sublines: [`${ago} ago`] };
};

/** Map a VerifyRun (or absence of one) to a RowData entry. */
const verifyRowData = (run: VerifyRun | undefined, now: number, shortLabel: string): RowData => {
  if (run === undefined) {
    return { label: shortLabel, tier: 'pending', status: 'not run yet' };
  }
  const ago = fmtElapsed(new Date(run.ranAt).getTime(), now);
  if (run.outcome === 'success') {
    return { label: shortLabel, tier: 'ok', sublines: [`${ago} ago`] };
  }
  if (run.outcome === 'failed') {
    return {
      label: shortLabel,
      tier: 'error',
      status: 'failed',
      sublines: [`exit ${String(run.exitCode)} · ${ago} ago`],
    };
  }
  if (run.outcome === SPAWN_ERROR_OUTCOME) {
    return { label: shortLabel, tier: 'warning', status: 'spawn error', sublines: [`${ago} ago`] };
  }
  return { label: shortLabel, tier: 'pending', status: 'skipped', sublines: [`${ago} ago`] };
};

const attributionRowData = (counts: AttributionCounts): RowData => {
  // "Attrib" keeps the label ≤12 chars and avoids wrap in the 28-col card.
  const label = 'Attrib';
  const total = counts.clean + counts.regressed + counts.fixedBaseline + counts.baselineBroken;
  if (total === 0) {
    return { label, tier: 'pending', status: 'no attempts yet' };
  }
  const broken = counts.regressed + counts.baselineBroken;
  const fixed = counts.fixedBaseline;
  const tier: Tier = counts.regressed > 0 ? 'error' : counts.baselineBroken > 0 ? 'warning' : 'ok';
  const parts: string[] = [];
  if (broken > 0) parts.push(`${String(broken)} broken`);
  if (fixed > 0) parts.push(`${String(fixed)} fixed`);
  if (counts.clean > 0) parts.push(`${String(counts.clean)} clean`);
  const subline = parts.join(' · ');
  return { label, tier, sublines: [subline] };
};

/** Card-tone palette. Mirrors the {@link Card} tone vocabulary. */
type CardTone = 'success' | 'warning' | 'error' | 'rule';

/** Map the shared baseline tier onto a Card tone. */
const toneFromTier = (tier: BaselineTier): CardTone => {
  if (tier === 'red') return 'error';
  if (tier === 'amber') return 'warning';
  if (tier === 'green') return 'success';
  return 'rule';
};

/**
 * Title-suffix logic uses the same predicate tier as the tone, then refines with the rows for fine-grained labels: -
 * tier `red` → first failing row's label, e.g.
 */
const titleSuffix = (rows: readonly RowData[], tier: BaselineTier): string | undefined => {
  if (tier === 'red') {
    const errRow = rows.find((r) => r.tier === 'error');
    return errRow !== undefined ? `${errRow.label.toLowerCase()} failed` : 'failed';
  }
  if (tier === 'green' && rows.every((r) => r.tier === 'ok')) return 'clean';
  return undefined;
};

/**
 * Single indicator row — compact inline variant for the expanded (mixed) state. Layout: `<glyph> <label> <detail>` —
 * everything on one line.
 */
const BaselineRow = ({ row }: { readonly row: RowData }): React.JSX.Element => {
  const color = tones[TIER_TONE[row.tier]].color;
  const glyph = tones[TIER_TONE[row.tier]].glyph;
  const isError = row.tier === 'error';

  // Pick the single most important detail token to show inline. error/warning: status phrase is more actionable than
  // elapsed. ok: elapsed (first subline).
  const detail: string | undefined =
    (row.tier === 'ok' ? (row.sublines?.[0] ?? row.status) : row.status) ?? row.sublines?.[0];

  return (
    <Text wrap="truncate-end">
      <Text color={color}>{glyph}</Text> <Text bold={isError}>{row.label}</Text>
      {detail !== undefined && (
        <>
          {' '}
          {isError ? (
            <Text color={color} bold>
              {detail}
            </Text>
          ) : (
            <Text dimColor>{detail}</Text>
          )}
        </>
      )}
    </Text>
  );
};

/** Compact all-clean row — four ticks with abbreviated labels on a single line. */
const COMPACT_ABBREV: Readonly<Record<string, string>> = {
  Setup: 'Stp',
  'Pre-task': 'Pre',
  'Post-task': 'Post',
  Attrib: 'Att',
};

const CompactCleanRow = ({ rows }: { readonly rows: readonly RowData[] }): React.JSX.Element => {
  // Build as a plain string to prevent ink from word-wrapping between label fragments.
  // No space between glyph and abbrev, single-space separator: "✓Stp ✓Pre ✓Post ✓Att" = 21 chars.
  const parts = rows.map((row) => `${tones[TIER_TONE[row.tier]].glyph}${COMPACT_ABBREV[row.label] ?? row.label}`);
  return (
    <Box>
      <Text dimColor>{parts.join(' ')}</Text>
    </Box>
  );
};

export const BaselineHealthCard = ({ execution, tasks, now, width }: BaselineHealthCardProps): React.JSX.Element => {
  const tNow = now ?? Date.now();
  // Wrap the `tasks ?? []` fallback in its own useMemo so the identity is stable across renders that don't change
  // `tasks`.
  const taskList = useMemo(() => tasks ?? [], [tasks]);
  const cardWidth = width ?? CONTEXT_WIDTH;

  const setupData = useMemo(() => setupRowData(execution, tNow), [execution, tNow]);
  const preRun = useMemo(() => latestVerifyRun(taskList, 'pre'), [taskList]);
  const postRun = useMemo(() => latestVerifyRun(taskList, 'post'), [taskList]);
  // Short labels (≤12 chars) to prevent wrapping inside the 28-col card.
  const preData = verifyRowData(preRun, tNow, 'Pre-task');
  const postData = verifyRowData(postRun, tNow, 'Post-task');
  const counts = useMemo(() => countAttributions(taskList), [taskList]);
  const attribData = attributionRowData(counts);

  const rows: readonly RowData[] = [setupData, preData, postData, attribData];
  // Tier (and therefore tone) come from the shared predicate so chip + card never disagree.
  const health = synthesiseBaselineHealth({
    ...(execution !== undefined ? { execution } : {}),
    tasks: taskList,
    now: tNow,
  });
  const tone = toneFromTier(health.tier);
  const suffix = titleSuffix(rows, health.tier);
  const title = suffix !== undefined ? `Baseline · ${suffix}` : 'Baseline';

  const isAllPending =
    setupData.tier === 'pending' &&
    preData.tier === 'pending' &&
    postData.tier === 'pending' &&
    attribData.tier === 'pending';

  const isAllClean =
    setupData.tier === 'ok' && preData.tier === 'ok' && postData.tier === 'ok' && attribData.tier === 'ok';

  return (
    <Box width={cardWidth} flexDirection="column">
      <Card title={title} tone={tone}>
        {isAllPending ? (
          <Box paddingY={0}>
            <Text dimColor italic>
              awaiting first run…
            </Text>
          </Box>
        ) : isAllClean ? (
          // Compact all-clean variant — minimal vertical footprint.
          <CompactCleanRow rows={rows} />
        ) : (
          // Expanded variant — one compact line per indicator, no inter-row gutters.
          <Box flexDirection="column">
            <BaselineRow row={setupData} />
            <BaselineRow row={preData} />
            <BaselineRow row={postData} />
            <BaselineRow row={attribData} />
          </Box>
        )}
      </Card>
    </Box>
  );
};
