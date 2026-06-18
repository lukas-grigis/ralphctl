/**
 * StatusBand — horizontal glanceable chrome row for the wide (≥140 col) Implement view.
 *
 * One fixed-height row that consolidates ALL the meta that previously cluttered the sidebar:
 *
 *   ● run-1 · RUNNING · 4m31s · sonnet→opus · baseline ✓ · tok 2.2M
 *
 * Design rationale: the band has zero vertical cost relative to the sidebar panels it replaces
 * (those 18+ rows of chrome are now the sidebar's body budget for task-nav + steps). It also
 * provides a stable glanceable strip that never scrolls off the top.
 *
 * Token display:
 *   - Plausible single-call: `ctx 53.6k/200k (27%)`
 *   - Cumulative claude data: `tok 2.2M` with no "/window" bar (see token-budget-card.tsx for
 *     the detailed honesty rationale).
 *
 * Baseline display:
 *   - Uses the compact `BaselineHealthChip` summary tier + label — same predicate as the card,
 *     one line.
 *
 * Layout separators: explicit `<Text> </Text>` nodes between every segment — Ink collapses
 * trailing spaces inside a styled Text, so spacers must be standalone Text nodes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { type BaselineTier, synthesiseBaselineHealth } from '@src/application/ui/tui/components/baseline-health.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtTokensCompact = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  if (k < 1000) return k >= 100 ? `${String(Math.round(k))}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  const m = n / 1_000_000;
  return m >= 10 ? `${String(Math.round(m))}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
};

const baselineTierColor = (tier: BaselineTier): string => {
  if (tier === 'green') return inkColors.success;
  if (tier === 'amber') return inkColors.warning;
  if (tier === 'red') return inkColors.error;
  return inkColors.muted;
};

const baselineTierGlyph = (tier: BaselineTier): string => {
  if (tier === 'green') return glyphs.check;
  if (tier === 'amber') return glyphs.warningGlyph;
  if (tier === 'red') return glyphs.cross;
  return glyphs.phasePending;
};

// ---------------------------------------------------------------------------
// Inline separator — a dim bullet, used as segment dividers in the band
// ---------------------------------------------------------------------------

const Sep = (): React.JSX.Element => (
  <>
    <Text> </Text>
    <Text color={inkColors.rule}>{glyphs.inlineDot}</Text>
    <Text> </Text>
  </>
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StatusBandProps {
  /** Session descriptor — drives status glyph, sprint label, flow, model pair. */
  readonly descriptor: SessionDescriptor;
  /** Whether the run is still in flight. */
  readonly isRunning: boolean;
  /** Wall-clock elapsed ms since run start — formatted inline. */
  readonly elapsedMs: number;
  /** Sprint execution state for baseline synthesis — undefined until polled. */
  readonly executionState?: SprintExecution;
  /** Task entities for baseline synthesis — undefined until polled. */
  readonly taskState?: readonly Task[];
  /** Token usage — undefined until the first TokenUsageEvent fires. */
  readonly tokenUsage?: TokenUsage;
  /** Sprint label pinned at launch — undefined for flows not tied to a sprint. */
  readonly pinnedSprintLabel?: string;
  /** Terminal column count — used for model-pair truncation decisions. */
  readonly termColumns: number;
  /** Wall-clock reference in ms — used for baseline staleness. */
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const StatusBand = ({
  descriptor,
  isRunning,
  elapsedMs,
  executionState,
  taskState,
  tokenUsage,
  pinnedSprintLabel,
  termColumns,
  now,
}: StatusBandProps): React.JSX.Element => {
  // ── Status glyph ────────────────────────────────────────────────────────
  const statusGlyph = isRunning ? glyphs.phaseActive : glyphs.phaseDone;
  const statusColor = isRunning ? inkColors.info : inkColors.success;

  // ── Elapsed ─────────────────────────────────────────────────────────────
  const elapsedS = Math.floor(elapsedMs / 1000);
  const elapsedLabel =
    elapsedS < 60
      ? `${String(elapsedS)}s`
      : `${String(Math.floor(elapsedS / 60))}m${String(elapsedS % 60).padStart(2, '0')}s`;

  // ── Model pair ──────────────────────────────────────────────────────────
  // Collapse to one name when equal; use arrow when different. Truncate before sprint label.
  const hasModels = descriptor.generatorModel !== undefined && descriptor.evaluatorModel !== undefined;
  const modelsMatch = descriptor.generatorModel === descriptor.evaluatorModel;
  const modelLabel = hasModels
    ? modelsMatch
      ? descriptor.generatorModel
      : `${descriptor.generatorModel ?? ''}${glyphs.arrowRight}${descriptor.evaluatorModel ?? ''}`
    : undefined;

  // Truncate model label when terminal is narrow — it's low-priority vs sprint name.
  // At 140 cols we have limited room; truncate at 30 chars so sprint name always shows.
  const maxModelChars = Math.max(10, Math.round(termColumns * 0.2));
  const truncatedModel =
    modelLabel !== undefined && modelLabel.length > maxModelChars
      ? `${modelLabel.slice(0, maxModelChars - 1)}${glyphs.clipEllipsis}`
      : modelLabel;

  // ── Baseline ────────────────────────────────────────────────────────────
  const health = synthesiseBaselineHealth({
    ...(executionState !== undefined ? { execution: executionState } : {}),
    ...(taskState !== undefined ? { tasks: taskState } : {}),
    now,
  });
  const baselineGlyph = baselineTierGlyph(health.tier);
  const baselineColor = baselineTierColor(health.tier);

  // ── Token summary ───────────────────────────────────────────────────────
  // Detect cumulative data: cacheRead >> contextWindow means claude -p cumulative totals.
  const input = tokenUsage?.inputTokens ?? 0;
  const cacheRead = tokenUsage?.cacheReadTokens ?? 0;
  const totalUsed = input + cacheRead;
  const contextWindow = tokenUsage?.contextWindow;
  const isCumulative = contextWindow !== undefined && contextWindow > 0 && totalUsed > contextWindow;
  let tokenLabel: string | undefined;
  if (tokenUsage !== undefined) {
    if (isCumulative) {
      // Cumulative: just show the total plainly
      tokenLabel = `tok ${fmtTokensCompact(totalUsed)}`;
    } else if (contextWindow !== undefined && contextWindow > 0) {
      const pct = Math.round((totalUsed / contextWindow) * 100);
      tokenLabel = `ctx ${fmtTokensCompact(totalUsed)}/${fmtTokensCompact(contextWindow)} (${String(pct)}%)`;
    } else if (totalUsed > 0) {
      tokenLabel = `tok ${fmtTokensCompact(totalUsed)}`;
    }
  }

  return (
    <Box paddingX={spacing.indent} marginTop={spacing.gutter}>
      {/* Status glyph + sprint name */}
      <Text color={statusColor}>{statusGlyph}</Text>
      <Text> </Text>
      <Text bold color={inkColors.highlight}>
        {pinnedSprintLabel ?? descriptor.title}
      </Text>
      {/* Run status label */}
      <Sep />
      <Text color={statusColor}>{isRunning ? 'RUNNING' : descriptor.status.toUpperCase()}</Text>
      {/* Elapsed */}
      <Sep />
      <Text dimColor>elapsed</Text>
      <Text> </Text>
      <Text>{elapsedLabel}</Text>
      {/* Model pair — truncated; omitted if no models (non-implement flows) */}
      {truncatedModel !== undefined && (
        <>
          <Sep />
          <Text dimColor>model</Text>
          <Text> </Text>
          <Text color={inkColors.muted} wrap="truncate-end">
            {truncatedModel}
          </Text>
        </>
      )}
      {/* Baseline health — compact inline */}
      <Sep />
      <Text dimColor>baseline</Text>
      <Text> </Text>
      <Text color={baselineColor}>{baselineGlyph}</Text>
      {/* Token summary — compact inline */}
      {tokenLabel !== undefined && (
        <>
          <Sep />
          <Text dimColor>{tokenLabel}</Text>
        </>
      )}
    </Box>
  );
};
