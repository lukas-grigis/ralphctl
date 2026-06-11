/**
 * Baseline-Health Card — surfaces the deterministic verify gate data the harness captures per
 * implement run, in the right-hand context column of the implement dashboard.
 *
 * Four signals collapse onto one card:
 *
 *  - `Setup`              — latest harness-side setup-script row per affected repo
 *                           (`SprintExecution.setupRanAt[last]`).
 *  - `Pre-task verify`    — most recent pre-task-verify row across every running/settled attempt.
 *  - `Post-task verify`   — most recent post-task-verify row.
 *  - `Attribution`        — count of `clean` / `regressed` / `fixed-baseline` / `baseline-broken`
 *                           verdicts across the sprint's attempts.
 *
 * Visual contract:
 *  - One row pattern throughout: `<BaselineRow>` — glyph + label, optional dim sub-line.
 *  - All-clean compact variant: a single summary line with four ticks; avoids wasted vertical space.
 *  - Title bar accent: error state → title reads `Baseline · <cause>` in `inkColors.error`;
 *    clean state → `Baseline · clean` in dim; pending/mixed → plain `Baseline`.
 *  - Fluid width at `xxl`: caller passes `width` (default `CONTEXT_WIDTH`); the card never
 *    hardcodes its own width.
 *
 * The card derives in-place from `SprintExecution` + `Task[]` — the entities the dashboard
 * already has access to. The wider `SprintState` projection this once anticipated was deleted
 * in Wave 7 (see the `tasks-projection.ts` header); there is no sprint-level verify
 * projection, by design.
 *
 * The chip variant in {@link BaselineHealthChip} is the single-line companion that
 * sits next to the breadcrumb.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { SetupRun, SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { VerifyRun } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { CONTEXT_WIDTH, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import {
  type AttributionCounts,
  type BaselineTier,
  countAttributions,
  latestVerifyRun,
  synthesiseBaselineHealth,
} from '@src/application/ui/tui/components/baseline-health.ts';

/**
 * Visual tier driven by status — maps to the existing semantic-state tokens.
 * `ok` / `warning` / `error` mirror the Card tone vocabulary; `pending` covers not-yet-run.
 */
type Tier = 'ok' | 'warning' | 'error' | 'pending';

/** @public */
export interface BaselineHealthCardProps {
  readonly execution?: SprintExecution;
  readonly tasks?: readonly Task[];
  /** Required for the "Xm ago" labels — falls back to `Date.now()` if absent. */
  readonly now?: number;
  /**
   * Card width in columns. Defaults to `CONTEXT_WIDTH` (28). Callers at `xxl` breakpoints may
   * pass a fluid value (e.g. `fluid(columns, { min: 28, max: 36, ratio: 0.14 })`).
   */
  readonly width?: number;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

const tierColor = (tier: Tier): string => {
  if (tier === 'ok') return inkColors.success;
  if (tier === 'warning') return inkColors.warning;
  if (tier === 'error') return inkColors.error;
  return inkColors.muted;
};

const tierGlyph = (tier: Tier): string => {
  if (tier === 'ok') return glyphs.check;
  if (tier === 'warning') return glyphs.warningGlyph;
  if (tier === 'error') return glyphs.cross;
  return glyphs.phasePending;
};

// ---------------------------------------------------------------------------
// Data model for a single indicator row
// ---------------------------------------------------------------------------

interface RowData {
  /**
   * Display label for the indicator (e.g. "Setup", "Pre verify").
   * Keep under ~14 chars so it never wraps at CONTEXT_WIDTH (28 cols).
   */
  readonly label: string;
  /** Visual tier drives glyph + color. */
  readonly tier: Tier;
  /**
   * Short status phrase that appears as the FIRST dim sub-line, before any
   * elapsed/count details. Omitted when the tier alone communicates success.
   * Keeping it on a sub-line (not inline) avoids wrap at narrow card widths.
   */
  readonly status?: string;
  /** Additional dim secondary lines — elapsed time, count, repo name, etc. */
  readonly sublines?: readonly string[];
}

// ---------------------------------------------------------------------------
// Setup-script derivation
// ---------------------------------------------------------------------------

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
  if (rows.length === 0) return 'pending';
  let hasFailed = false;
  let hasSpawnError = false;
  let allSkipped = true;
  for (const row of rows) {
    if (row.outcome !== 'skipped') allSkipped = false;
    if (row.outcome === 'failed') hasFailed = true;
    if (row.outcome === 'spawn-error') hasSpawnError = true;
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
    const failedCount = latest.filter((r) => r.outcome === 'failed' || r.outcome === 'spawn-error').length;
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

// ---------------------------------------------------------------------------
// Verify-run derivation
// ---------------------------------------------------------------------------

/**
 * Map a VerifyRun (or absence of one) to a RowData entry.
 * `shortLabel` is the display name for the row — callers pass "Pre verify" / "Post verify"
 * (≤12 chars) to guarantee the label never wraps inside the 28-col card.
 */
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
  if (run.outcome === 'spawn-error') {
    return { label: shortLabel, tier: 'warning', status: 'spawn error', sublines: [`${ago} ago`] };
  }
  return { label: shortLabel, tier: 'pending', status: 'skipped', sublines: [`${ago} ago`] };
};

// ---------------------------------------------------------------------------
// Attribution derivation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Card-level tone
// ---------------------------------------------------------------------------

/** Card-tone palette. Mirrors the {@link Card} tone vocabulary. */
type CardTone = 'success' | 'warning' | 'error' | 'rule';

/**
 * Map the shared baseline tier onto a Card tone. This is the load-bearing call that keeps
 * the card's border / title color in sync with the {@link BaselineHealthChip} — both surfaces
 * read the same tier from {@link synthesiseBaselineHealth}.
 */
const toneFromTier = (tier: BaselineTier): CardTone => {
  if (tier === 'red') return 'error';
  if (tier === 'amber') return 'warning';
  if (tier === 'green') return 'success';
  return 'rule';
};

/**
 * Title-suffix logic uses the same predicate tier as the tone, then refines with the rows
 * for fine-grained labels:
 *
 *  - tier `red`   → first failing row's label, e.g. `"setup failed"` / `"post verify failed"`.
 *  - tier `green` → `"clean"` only when EVERY row is ok (not mixed ok + pending).
 *  - otherwise    → no suffix; plain `"Baseline"` title.
 */
const titleSuffix = (rows: readonly RowData[], tier: BaselineTier): string | undefined => {
  if (tier === 'red') {
    const errRow = rows.find((r) => r.tier === 'error');
    return errRow !== undefined ? `${errRow.label.toLowerCase()} failed` : 'failed';
  }
  if (tier === 'green' && rows.every((r) => r.tier === 'ok')) return 'clean';
  return undefined;
};

// ---------------------------------------------------------------------------
// Internal primitives
// ---------------------------------------------------------------------------

/**
 * Single indicator row. Consistent shape throughout the card:
 *
 *   `<glyph> <label>`                  ← line 1; label bold on error
 *   `  <status>`                        ← dim sub-line (when status present)
 *   `  <detail…>`                       ← dim sub-lines (elapsed, counts, etc.)
 *
 * Status lives on a sub-line (not inline after the label) so the row never wraps
 * at narrow card widths — the label is always a clean single line.
 *
 * When `tier` is `error` the label is bold so the actionable signal is dominant.
 */
const BaselineRow = ({ row }: { readonly row: RowData }): React.JSX.Element => {
  const color = tierColor(row.tier);
  const glyph = tierGlyph(row.tier);
  const isError = row.tier === 'error';
  return (
    <Box flexDirection="column">
      {/* Headline: glyph + label */}
      <Box>
        <Text color={color}>{glyph}</Text>
        <Text> </Text>
        <Text bold={isError}>{row.label}</Text>
      </Box>
      {/* Status sub-line (e.g. "failed", "not run yet", "spawn error") */}
      {row.status !== undefined && (
        <Box paddingLeft={spacing.indent}>
          {isError ? (
            <Text color={color} bold>
              {row.status}
            </Text>
          ) : (
            <Text dimColor>{row.status}</Text>
          )}
        </Box>
      )}
      {/* Detail sub-lines (elapsed, counts, etc.) */}
      {row.sublines !== undefined &&
        row.sublines.map((line) => (
          <Box key={line} paddingLeft={spacing.indent}>
            <Text dimColor>{line}</Text>
          </Box>
        ))}
    </Box>
  );
};

/**
 * Compact all-clean row — four ticks with abbreviated labels on a single line.
 * Rendered only when every indicator is `ok`; saves vertical space when nothing needs attention.
 *
 * To prevent wrapping inside the 28-col card (24 usable chars with borders/padding) we use
 * abbreviated one-word labels and render the entire content as a single `<Text>` node so ink
 * never breaks mid-label. The plain-text line fits: "✓ Setup  ✓ Pre  ✓ Post  ✓ Attrib" = 32
 * chars — still too long, so we use single-char separators and the tightest abbrevs that read.
 * Final shape: "✓ Stp  ✓ Pre  ✓ Post  ✓ Att" ≈ 28 chars → fits within the card body.
 *
 * Abbreviated map (kept stable so snapshots don't shift):
 *   Setup       → Stp
 *   Pre verify  → Pre
 *   Post verify → Post
 *   Attrib      → Att
 */
const COMPACT_ABBREV: Readonly<Record<string, string>> = {
  Setup: 'Stp',
  'Pre verify': 'Pre',
  'Post verify': 'Post',
  Attrib: 'Att',
};

const CompactCleanRow = ({ rows }: { readonly rows: readonly RowData[] }): React.JSX.Element => {
  // Build as a plain string to prevent ink from word-wrapping between label fragments.
  // No space between glyph and abbrev, single-space separator: "✓Stp ✓Pre ✓Post ✓Att" = 21 chars.
  const parts = rows.map((row) => `${tierGlyph(row.tier)}${COMPACT_ABBREV[row.label] ?? row.label}`);
  return (
    <Box>
      <Text dimColor>{parts.join(' ')}</Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export const BaselineHealthCard = ({ execution, tasks, now, width }: BaselineHealthCardProps): React.JSX.Element => {
  const tNow = now ?? Date.now();
  // Wrap the `tasks ?? []` fallback in its own useMemo so the identity is stable across
  // renders that don't change `tasks`. Without this, the inline `??` allocates a fresh empty
  // array each render, which would cascade into re-running every downstream `useMemo` that
  // takes `taskList` as a dep — defeating the memo'd setup/verify-row computations.
  const taskList = useMemo(() => tasks ?? [], [tasks]);
  const cardWidth = width ?? CONTEXT_WIDTH;

  const setupData = useMemo(() => setupRowData(execution, tNow), [execution, tNow]);
  const preRun = useMemo(() => latestVerifyRun(taskList, 'pre'), [taskList]);
  const postRun = useMemo(() => latestVerifyRun(taskList, 'post'), [taskList]);
  // Short labels (≤12 chars) to prevent wrapping inside the 28-col card.
  const preData = verifyRowData(preRun, tNow, 'Pre verify');
  const postData = verifyRowData(postRun, tNow, 'Post verify');
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
          // Expanded variant — one row per indicator with sub-lines.
          <Box flexDirection="column">
            <BaselineRow row={setupData} />
            <Box marginTop={spacing.gutter}>
              <BaselineRow row={preData} />
            </Box>
            <Box marginTop={spacing.gutter}>
              <BaselineRow row={postData} />
            </Box>
            <Box marginTop={spacing.gutter}>
              <BaselineRow row={attribData} />
            </Box>
          </Box>
        )}
      </Card>
    </Box>
  );
};
