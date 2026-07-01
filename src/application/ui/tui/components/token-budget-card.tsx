/**
 * Token / attention-budget card — surfaces the latest `TokenUsageEvent` for a given session in
 * the right-hand context column of the Implement dashboard. Sits below the baseline-health card.
 *
 * Splits the figures into TWO clearly labelled groups, because they answer different questions:
 *
 *   Usage  (cumulative — what hit the API: throughput / billing)
 *     input/output: 41.2k / 18.5k
 *     cache hit: 12.4k (24%)
 *
 *   Context  (effective window occupancy right now)
 *     53.6k / 200k  ███░░░░░░░ 27%
 *
 * - **Usage** is the cumulative spawn total: for claude `-p` these counts sum across every
 *   internal turn, so they are a throughput / billing view, NOT context occupancy. No `/window`
 *   denominator and no % bar is ever drawn from these numbers.
 * - **Context** is the effective context-window occupancy. When the provider reports per-turn
 *   "live" counters (`liveInputTokens + liveCacheReadTokens + liveCacheCreationTokens`, claude
 *   `-p` only) we use them directly — that sum is the true window fill regardless of how the
 *   cumulative figures aggregate. The bar + % render from this.
 * - Fallback when live counters are absent (copilot / codex, or no assistant usage captured):
 *   the cumulative-derived `inputTokens + cacheReadTokens` figure is shown ONLY when it is
 *   plausibly a single call (`totalUsed <= contextWindow`) — then it gets a bar. When it exceeds
 *   the window it is almost certainly cumulative; we render `session: N (cumulative)` WITHOUT a
 *   misleading % bar. A bar is NEVER drawn from cumulative data.
 * - Numbers are compacted (`41.2k`) so the card stays scannable inside the narrow context column.
 *   The cache hit row is omitted when the provider reported neither cache counter.
 * - The bar width is fixed at 10 cells so it fits {@link CONTEXT_WIDTH} with the percentage
 *   appended; `contextPct` is clamped at 100 so an over-budget record cannot overflow the bar.
 * - Cache-hit ratio uses `cacheRead / (cacheRead + input)` — the fraction of the prompt served
 *   from cache, always 0–100%.
 * - When no `TokenUsageEvent` has fired yet for the session the card renders an empty-state
 *   "no usage data" line so the operator sees a placeholder, not an absent widget.
 *
 * The card is a pure renderer over {@link TokenUsage}; the {@link useTokenUsage} hook does the
 * bus subscription + per-session bookkeeping.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { fmtTokens } from '@src/application/ui/tui/components/format.ts';
import { CONTEXT_WIDTH, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';

/** @public */
export interface TokenBudgetCardProps {
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}

/** Width of the context-window progress bar in cells. Sized to fit inside {@link CONTEXT_WIDTH}. */
const BAR_WIDTH = 10;

/** Render an ASCII progress bar of the configured width — filled-blocks for used, light-shade for remaining. */
const renderBar = (filled: number): string => {
  const clamped = Math.max(0, Math.min(BAR_WIDTH, Math.round(filled)));
  return `${'█'.repeat(clamped)}${'░'.repeat(BAR_WIDTH - clamped)}`;
};

/**
 * Short session id — the live execute view shows the runner's full id in its title; the budget
 * card uses an 8-char prefix so multiple stacked cards stay legible in the narrow column.
 */
const shortSession = (id: string): string => `sess-${id.slice(0, 8)}`;

/** Tier colour for the percentage label — green under 60%, warning amber 60-85%, error above 85%. */
const pctColor = (pct: number): string => {
  if (pct < 60) return inkColors.success;
  if (pct < 85) return inkColors.warning;
  return inkColors.error;
};

/**
 * Effective context-window occupancy, resolved from a {@link TokenUsage} record. Prefers the
 * per-turn LIVE counters (claude `-p`) whose sum is the true window fill; falls back to the
 * cumulative-derived `input + cacheRead` figure, drawing a bar only when that figure plausibly
 * fits a single call (`<= contextWindow`). Cumulative-but-over-window data gets no bar — a
 * "2.2M / 200k 100%" bar would mislead.
 */
interface ContextView {
  /** Tokens occupying the window right now (live sum, or cumulative-derived fallback). */
  readonly used: number;
  /** True when a % bar may be drawn (live data, or cumulative that fits the window). */
  readonly showBar: boolean;
  /** True when data is cumulative + over-window → render the "(cumulative)" note instead. */
  readonly showCumulativeNote: boolean;
  readonly pct: number;
  readonly filled: number;
}

interface LiveUsage {
  readonly hasLive: boolean;
  readonly liveUsed: number;
}

/** Sum of the per-turn LIVE counters (claude `-p` only) — the true window fill when present. */
const resolveLiveUsage = (usage: TokenUsage): LiveUsage => {
  const hasLive =
    usage.liveInputTokens !== undefined ||
    usage.liveCacheReadTokens !== undefined ||
    usage.liveCacheCreationTokens !== undefined;
  const liveUsed =
    (usage.liveInputTokens ?? 0) + (usage.liveCacheReadTokens ?? 0) + (usage.liveCacheCreationTokens ?? 0);
  return { hasLive, liveUsed };
};

interface CumulativeUsage {
  readonly cumulativeUsed: number;
  readonly cumulativeFitsWindow: boolean;
}

/** Cumulative-derived fallback used when the provider reports no per-turn LIVE counters. */
const resolveCumulativeUsage = (
  usage: TokenUsage,
  contextWindow: number | undefined,
  hasWindow: boolean
): CumulativeUsage => {
  // Output tokens don't occupy the window, so cumulative context used = input + cacheRead.
  const cumulativeUsed = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  const cumulativeFitsWindow = hasWindow && contextWindow !== undefined && cumulativeUsed <= contextWindow;
  return { cumulativeUsed, cumulativeFitsWindow };
};

const computeContext = (usage: TokenUsage): ContextView => {
  const contextWindow = usage.contextWindow;
  const hasWindow = contextWindow !== undefined && contextWindow > 0;

  const { hasLive, liveUsed } = resolveLiveUsage(usage);
  const { cumulativeUsed, cumulativeFitsWindow } = resolveCumulativeUsage(usage, contextWindow, hasWindow);

  const used = hasLive ? liveUsed : cumulativeUsed;
  const showBar = hasWindow && (hasLive || cumulativeFitsWindow);
  const showCumulativeNote = !hasLive && hasWindow && !cumulativeFitsWindow;
  const pct = showBar && contextWindow !== undefined ? Math.min(100, Math.round((used / contextWindow) * 100)) : 0;
  const filled = showBar && contextWindow !== undefined ? (used / contextWindow) * BAR_WIDTH : 0;

  return { used, showBar, showCumulativeNote, pct, filled };
};

interface UsageGroupValues {
  /** Raw (possibly-undefined) input-token count — rendered as `?` when the provider omitted it. */
  readonly inputTokens: number | undefined;
  readonly output: number | undefined;
  readonly cacheRead: number;
  readonly cacheTotal: number;
  readonly cachePct: number | undefined;
}

/** Cumulative throughput / billing figures for the Usage group, derived from a {@link TokenUsage} record. */
const computeUsageGroup = (usage: TokenUsage): UsageGroupValues => {
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreate = usage.cacheCreationTokens ?? 0;
  const cacheTotal = cacheRead + cacheCreate;

  // Cache-hit rate: fraction of the prompt served from cache (always 0–100%).
  // Formula: cacheRead / (cacheRead + input), i.e. how much of the prompt was already cached.
  const cacheBase = cacheRead + input;
  const cachePct = cacheBase > 0 && cacheRead > 0 ? Math.round((cacheRead / cacheBase) * 100) : undefined;

  return { inputTokens: usage.inputTokens, output: usage.outputTokens, cacheRead, cacheTotal, cachePct };
};

/** Cumulative throughput / billing group — input/output totals plus the optional cache-hit row. */
const UsageGroup = ({ inputTokens, output, cacheRead, cacheTotal, cachePct }: UsageGroupValues): React.JSX.Element => (
  <>
    <Text dimColor bold>
      Usage
    </Text>
    {/* input/output row: use a single outer Text wrapper so Ink treats the entire
        line as one text block — no flex-column splitting between label and value.
        Inner Text nodes only apply colour; they do not create separate flex items. */}
    <Text>
      <Text dimColor>in/out:</Text> {inputTokens !== undefined ? fmtTokens(inputTokens) : '?'} /{' '}
      {output !== undefined ? fmtTokens(output) : '?'}
    </Text>
    {cacheTotal > 0 && (
      <Box>
        {/* Explicit standalone space node — Ink collapses trailing spaces inside a
            styled Text node, so the gap between label and value must be a plain
            un-styled adjacent node. */}
        <Text dimColor>cache hit:</Text>
        <Text> </Text>
        <Text>{fmtTokens(cacheRead)}</Text>
        {cachePct !== undefined && (
          <>
            <Text> </Text>
            <Text dimColor>({String(cachePct)}%)</Text>
          </>
        )}
      </Box>
    )}
  </>
);

interface ContextGroupProps {
  readonly usage: TokenUsage;
  readonly modelWindowLabel: string | undefined;
  readonly ctx: ContextView;
  readonly contextWindow: number | undefined;
}

/** Effective context-window occupancy group — model label, used/window figure, and the optional % bar. */
const ContextGroup = ({ usage, modelWindowLabel, ctx, contextWindow }: ContextGroupProps): React.JSX.Element => (
  <Box marginTop={spacing.gutter} flexDirection="column">
    <Text dimColor bold>
      Context
    </Text>
    {/* Model descriptor: shows which model's window is the denominator. Omitted when
        the model is unknown so the card degrades cleanly for providers that don't
        report a model name. */}
    {usage.model !== undefined && (
      <Box>
        <Text dimColor>{usage.model}</Text>
        {modelWindowLabel !== undefined && (
          <>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text dimColor>{modelWindowLabel}</Text>
          </>
        )}
      </Box>
    )}
    {ctx.showCumulativeNote ? (
      // Cumulative data over the window: raw total labelled as session-cumulative; no
      // "/window" denominator and no % bar — a "2.2M / 200k 100%" bar would mislead.
      <Text>
        <Text dimColor>session:</Text>
        {` ${fmtTokens(ctx.used)} `}
        <Text dimColor>(cumulative)</Text>
      </Text>
    ) : (
      <Text>
        {fmtTokens(ctx.used)} / {contextWindow !== undefined ? fmtTokens(contextWindow) : '?'}
      </Text>
    )}
    {ctx.showBar && (
      <Box>
        <Text color={pctColor(ctx.pct)}>{renderBar(ctx.filled)}</Text>
        <Text> </Text>
        <Text color={pctColor(ctx.pct)}>{String(ctx.pct)}%</Text>
      </Box>
    )}
  </Box>
);

export const TokenBudgetCard = ({ sessionId, usage }: TokenBudgetCardProps): React.JSX.Element => {
  const title = `Tokens · ${shortSession(sessionId)}`;
  if (usage === undefined) {
    return (
      <Box width={CONTEXT_WIDTH} flexDirection="column">
        <Card title={title} tone="rule">
          <Box paddingY={0}>
            <Text dimColor italic>
              no usage data
            </Text>
          </Box>
        </Card>
      </Box>
    );
  }

  const usageGroup = computeUsageGroup(usage);

  const contextWindow = usage.contextWindow;
  const hasLive =
    usage.liveInputTokens !== undefined ||
    usage.liveCacheReadTokens !== undefined ||
    usage.liveCacheCreationTokens !== undefined;
  const hasUsageData = usage.inputTokens !== undefined || usage.outputTokens !== undefined || hasLive;
  const ctx = computeContext(usage);
  // Model descriptor for the Context group — shown as a dim sub-label so the denominator
  // (e.g. `53.6k / 200k`) is self-explanatory without needing to cross-reference the header.
  const modelWindowLabel = contextWindowLabel(usage.model);

  return (
    <Box width={CONTEXT_WIDTH} flexDirection="column">
      <Card title={title} tone="info">
        <Box flexDirection="column">
          {/* ── Usage group (cumulative / billing) ── */}
          <UsageGroup {...usageGroup} />

          {/* ── Context group (effective window occupancy) ── */}
          {hasUsageData && (
            <ContextGroup usage={usage} modelWindowLabel={modelWindowLabel} ctx={ctx} contextWindow={contextWindow} />
          )}
        </Box>
      </Card>
    </Box>
  );
};
