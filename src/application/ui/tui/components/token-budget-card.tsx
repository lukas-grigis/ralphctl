/**
 * Token / attention-budget card — surfaces the latest `TokenUsageEvent` for a given session in
 * the right-hand context column of the Implement dashboard. Sits below the baseline-health card.
 *
 * Renders three lines per usage record:
 *
 *   input/output: 41.2k / 18.5k
 *   cache hit: 12.4k (24%)
 *   context: 89.7k / 200k  ███████░░░ 45%
 *
 * - Numbers are compacted (`41.2k`) so the card stays scannable inside the narrow context
 *   column. The cache hit row is omitted when the provider reported neither cache counter.
 * - The context bar renders when both `inputTokens` and `outputTokens` and `contextWindow` are
 *   known; otherwise the context row degrades to the bare `89.7k / ?` form without the bar.
 *   Width is fixed at 10 cells so it fits the {@link CONTEXT_WIDTH} column with the percentage
 *   appended.
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

/** @public */
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

  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreate = usage.cacheCreationTokens ?? 0;
  const cacheTotal = cacheRead + cacheCreate;
  const contextWindow = usage.contextWindow;
  const totalUsed = (input ?? 0) + (output ?? 0);
  const hasContext = contextWindow !== undefined && contextWindow > 0 && (input !== undefined || output !== undefined);
  const contextPct = hasContext && contextWindow !== undefined ? Math.round((totalUsed / contextWindow) * 100) : 0;
  const filled = hasContext && contextWindow !== undefined ? (totalUsed / contextWindow) * BAR_WIDTH : 0;
  // Cache hit ratio measured against input tokens — Anthropic's metric of choice, and the only
  // ratio that's meaningful at a glance (a high cache:input ratio means the harness is feeding
  // the model a stable prompt scaffold; low ratios spot the "blew the cache every turn" failure).
  const cachePct = input !== undefined && input > 0 ? Math.round((cacheTotal / input) * 100) : undefined;

  return (
    <Box width={CONTEXT_WIDTH} flexDirection="column">
      <Card title={title} tone="info">
        <Box flexDirection="column">
          <Box>
            <Text dimColor>input/output: </Text>
            <Text>
              {input !== undefined ? fmtTokens(input) : '?'} / {output !== undefined ? fmtTokens(output) : '?'}
            </Text>
          </Box>
          {cacheTotal > 0 && (
            <Box marginTop={spacing.gutter}>
              <Text dimColor>cache hit: </Text>
              <Text>{fmtTokens(cacheTotal)}</Text>
              {cachePct !== undefined && <Text dimColor> ({String(cachePct)}%)</Text>}
            </Box>
          )}
          <Box marginTop={spacing.gutter}>
            <Text dimColor>context: </Text>
            <Text>
              {fmtTokens(totalUsed)} / {contextWindow !== undefined ? fmtTokens(contextWindow) : '?'}
            </Text>
          </Box>
          {hasContext && (
            <Box>
              <Text color={pctColor(contextPct)}>{renderBar(filled)}</Text>
              <Text color={pctColor(contextPct)}> {String(contextPct)}%</Text>
            </Box>
          )}
        </Box>
      </Card>
    </Box>
  );
};
