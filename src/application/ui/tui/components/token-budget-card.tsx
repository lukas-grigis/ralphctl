/**
 * Token / attention-budget card — surfaces the latest `TokenUsageEvent` for a given session in
 * the right-hand context column of the Implement dashboard. Sits below the baseline-health card.
 *
 * Renders three lines per usage record:
 *
 *   input/output: 41.2k / 18.5k
 *   cache hit: 12.4k (24%)
 *   context: 53.6k / 200k  ███░░░░░░░ 27%
 *
 * - Numbers are compacted (`41.2k`) so the card stays scannable inside the narrow context
 *   column. The cache hit row is omitted when the provider reported neither cache counter.
 * - "Context used" is `inputTokens + cacheReadTokens` — output tokens do not consume the context
 *   window, so they are excluded from the context figure and bar (they still show in the top row).
 * - The context bar renders ONLY when `totalUsed <= contextWindow` (i.e. a plausible single-call
 *   context — copilot / codex / claude early in a turn). The claude `-p` provider reports
 *   CUMULATIVE spawn-total usage: `inputTokens + cacheReadTokens` can hugely exceed the context
 *   window after many rounds (e.g. cacheRead 2.2M against a 200k window). Rendering a "2.2M /
 *   200k  ██████ 100%" bar is actively misleading; we show the raw totals plainly instead.
 * - The context bar renders when `contextWindow` is known alongside input or output; otherwise the
 *   context row degrades to the bare `53.6k / ?` form without the bar. `contextPct` is clamped at
 *   100 so an over-budget record cannot overflow the bar.
 *   Width is fixed at 10 cells so it fits the {@link CONTEXT_WIDTH} column with the percentage
 *   appended.
 * - Cache-hit ratio uses `cacheRead / (cacheRead + input)` — the fraction of the prompt served
 *   from cache. This is always 0–100%. The prior formula (`cacheTotal / input`) could produce
 *   thousands-of-percent values when the cumulative cacheRead dwarfs input, which was misleading.
 * - When no `TokenUsageEvent` has fired yet for the session the card renders an empty-state
 *   "no usage data" line so the operator sees a placeholder, not an absent widget.
 *
 * The card is a pure renderer over {@link TokenUsage}; the {@link useTokenUsage} hook does the
 * bus subscription + per-session bookkeeping.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { CONTEXT_WIDTH, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

/** @public */
export interface TokenBudgetCardProps {
  readonly sessionId: string;
  readonly usage?: TokenUsage;
}

/** Width of the context-window progress bar in cells. Sized to fit inside {@link CONTEXT_WIDTH}. */
const BAR_WIDTH = 10;

/**
 * Compact a token count for display: `200000` → `200k`, `12400` → `12.4k`, `120` → `120`. The
 * context column is narrow; truncating to a one-or-two-char `k` suffix keeps every row scannable.
 */
const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k >= 100 ? `${String(Math.round(k))}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
};

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

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreate = usage.cacheCreationTokens ?? 0;
  const cacheTotal = cacheRead + cacheCreate;
  const contextWindow = usage.contextWindow;
  const totalUsed = input + cacheRead;

  // Cache-hit rate: fraction of the prompt served from cache (always 0–100%).
  // Formula: cacheRead / (cacheRead + input), i.e. how much of the prompt was already cached.
  // The prior `cacheTotal / input` formula could produce thousands-of-% when cumulative
  // cacheRead >> input (common with the claude -p cumulative-usage data).
  const cacheBase = cacheRead + input;
  const cachePct = cacheBase > 0 && cacheRead > 0 ? Math.round((cacheRead / cacheBase) * 100) : undefined;

  // Show the context bar ONLY when totalUsed is plausibly a real single-call window utilisation.
  // When totalUsed > contextWindow the data is almost certainly cumulative (claude -p reports
  // spawn-total cacheRead that grows without bound). A "2.2M / 200k  ██ 100%" bar would be
  // actively misleading — show raw totals instead.
  const hasContext =
    contextWindow !== undefined && contextWindow > 0 && (usage.inputTokens !== undefined || output !== undefined);
  const isCumulative = hasContext && contextWindow !== undefined && totalUsed > contextWindow;
  const contextPct =
    hasContext && !isCumulative && contextWindow !== undefined
      ? Math.min(100, Math.round((totalUsed / contextWindow) * 100))
      : 0;
  const filled =
    hasContext && !isCumulative && contextWindow !== undefined ? (totalUsed / contextWindow) * BAR_WIDTH : 0;

  return (
    <Box width={CONTEXT_WIDTH} flexDirection="column">
      <Card title={title} tone="info">
        <Box flexDirection="column">
          {/* input/output row: use a single outer Text wrapper so Ink treats the entire
              line as one text block — no flex-column splitting between label and value.
              Inner Text nodes only apply colour; they do not create separate flex items. */}
          <Text>
            <Text dimColor>input/output:</Text> {usage.inputTokens !== undefined ? fmtTokens(usage.inputTokens) : '?'} /{' '}
            {output !== undefined ? fmtTokens(output) : '?'}
          </Text>
          {cacheTotal > 0 && (
            <Box marginTop={spacing.gutter}>
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
          <Box marginTop={spacing.gutter}>
            {isCumulative ? (
              // Cumulative data: raw totals plainly; no "/window" or "N% bar".
              // The claude -p provider reports spawn-total cacheRead that can hugely
              // exceed the context window — a "100%" bar would be actively misleading.
              <Text>
                <Text dimColor>tok:</Text>
                {` ${fmtTokens(totalUsed)}`}
                <Text dimColor> cumul.</Text>
              </Text>
            ) : (
              <Text>
                <Text dimColor>context:</Text> {fmtTokens(totalUsed)} /{' '}
                {contextWindow !== undefined ? fmtTokens(contextWindow) : '?'}
              </Text>
            )}
          </Box>
          {hasContext && !isCumulative && (
            <Box>
              <Text color={pctColor(contextPct)}>{renderBar(filled)}</Text>
              <Text> </Text>
              <Text color={pctColor(contextPct)}>{String(contextPct)}%</Text>
            </Box>
          )}
        </Box>
      </Card>
    </Box>
  );
};
