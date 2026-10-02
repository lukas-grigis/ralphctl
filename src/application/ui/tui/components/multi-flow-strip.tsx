/**
 * Multi-flow strip — a single-row chip rail above the Implement section-stamp showing each running flow as `[N] ·
 * <flowId>: <title-short> ⏱<elapsed>`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { clipWithEllipsis } from '@src/application/ui/tui/components/format.ts';

/** Navigation cue sourced from the keyboard map so it tracks the bindings the router honours. */
const NAV_HINT = `${globalKeys.cycleSession.keys.join('/')} cycle ${glyphs.bullet} ${globalKeys.jumpSession.keys.join('/')} jump`;

/** @public */
export interface MultiFlowStripProps {
  /** Every session known to the manager — the strip filters to `running` itself. */
  readonly sessions: readonly SessionRecord[];
  /** Currently-displayed session; its chip is highlighted. */
  readonly activeId: string;
  /** Wall-clock for elapsed-time labels. Falls back to `Date.now()` if absent. */
  readonly now?: number;
  /** Max title chars per chip — plain-clipped (no Ink truncate; chips share one row). */
  readonly maxTitleChars?: number;
  /** Runs blocked on a prompt — their chip reads `WAITING` instead of the elapsed time. */
  readonly awaiting?: ReadonlyMap<string, number>;
}

/** One chip. Layout: `[N] · <flowId>: <title> ⏱<elapsed>`. */
const Chip = ({
  index,
  session,
  active,
  now,
  maxTitleChars,
  waiting,
}: {
  readonly index: number;
  readonly session: SessionRecord;
  readonly active: boolean;
  readonly now: number;
  readonly maxTitleChars: number;
  readonly waiting: boolean;
}): React.JSX.Element => {
  const { descriptor } = session;
  const elapsed = fmtElapsed(descriptor.startedAt, descriptor.finishedAt ?? now);
  // Title is plain-clipped (not Ink-truncated) because chips sit on one row separated by `|`
  // and per-chip truncate-end boxes would each claim flexGrow, fighting each other for width.
  const title = clipWithEllipsis(descriptor.title, maxTitleChars);
  const color = waiting ? inkColors.warning : active ? inkColors.highlight : inkColors.muted;
  return (
    <Text color={color} bold={active || waiting}>
      [{String(index + 1)}] {glyphs.bullet} {descriptor.flowId}: {title}{' '}
      {waiting ? `${glyphs.warningGlyph} WAITING` : `⏱${elapsed}`}
    </Text>
  );
};

export const MultiFlowStrip = ({
  sessions,
  activeId,
  now,
  maxTitleChars = 18,
  awaiting,
}: MultiFlowStripProps): React.JSX.Element | null => {
  const tNow = now ?? Date.now();
  // Strip only renders for *running* flows — completed / failed / aborted clutter the
  // navigation cue and don't accept Tab focus from the multi-flow router anyway.
  const running = sessions.filter((s) => s.descriptor.status === 'running');
  if (running.length < 2) return null;
  return (
    <Box justifyContent="space-between" paddingX={spacing.indent}>
      <Box>
        {running.map((s, i) => (
          <Box key={s.descriptor.id} marginRight={i < running.length - 1 ? 1 : 0}>
            <Chip
              index={i}
              session={s}
              active={s.descriptor.id === activeId}
              now={tNow}
              maxTitleChars={maxTitleChars}
              waiting={awaiting?.has(s.descriptor.id) ?? false}
            />
            {i < running.length - 1 && <Text dimColor> {glyphs.pipe}</Text>}
          </Box>
        ))}
      </Box>
      <Text dimColor>{NAV_HINT}</Text>
    </Box>
  );
};
