/**
 * Multi-flow strip — a single-row chip rail above the Implement section-stamp showing each
 * running flow as `[N] · <flowId>: <title-short> ⏱<elapsed>`. The chip for the currently-focused
 * session is highlighted (`inkColors.accent`-equivalent: `inkColors.highlight`); the rest dim.
 *
 * Renders nothing when fewer than two sessions are running — a single flow doesn't warrant the
 * row, and the zero-pixel cost matches the design intent (no chrome when there's nothing to
 * disambiguate).
 *
 * The navigation annotation pins at the right end of the strip (justifyContent space-between) so
 * the operator's eye finds the hint in a stable spot. It advertises both real chords sourced from
 * {@link globalKeys}: `cycleSession` (Tab / Shift+Tab cycle the running sessions) and `jumpSession`
 * (Ctrl+1..9 direct-jump to the Nth running flow). The chord strings are read from the keyboard map
 * rather than hardcoded so the cue can't drift from the bindings the router actually honours.
 *
 * Pure renderer over `sessions` + `activeId` + `now`; the bus subscription and session list live
 * in the parent (execute-view).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

/**
 * Navigation cue sourced from the keyboard map so it tracks the bindings the router honours.
 * `cycleSession.keys` (`Tab` / `Shift+Tab`) joined with `/` reads as both directions; `jumpSession`
 * adds the Ctrl+N direct-jump chord that the `[N]` chip prefix indexes into.
 */
const NAV_HINT = `${globalKeys.cycleSession.keys.join('/')} cycle ${glyphs.bullet} ${globalKeys.jumpSession.keys.join('/')} jump`;

/** @public */
export interface MultiFlowStripProps {
  /** Every session known to the manager — the strip filters to `running` itself. */
  readonly sessions: readonly SessionRecord[];
  /** Currently-displayed session; its chip is highlighted. */
  readonly activeId: string;
  /** Wall-clock for elapsed-time labels. Falls back to `Date.now()` if absent. */
  readonly now?: number;
  /** Max title chars per chip — clipped via slice (no Ink truncate; chips share one row). */
  readonly maxTitleChars?: number;
}

/**
 * One chip. Layout: `[N] · <flowId>: <title> ⏱<elapsed>`. Active chip uses the highlight
 * colour; others dim. The leading `[N]` is the live `Ctrl+N` direct-jump index for this running
 * session ({@link globalKeys.jumpSession}): pressing `Ctrl+1..9` jumps to the Nth running flow.
 * The running-session list (and SessionsView) order by `startedAt`, so the index is stable for the
 * duration of a run.
 */
const Chip = ({
  index,
  session,
  active,
  now,
  maxTitleChars,
}: {
  readonly index: number;
  readonly session: SessionRecord;
  readonly active: boolean;
  readonly now: number;
  readonly maxTitleChars: number;
}): React.JSX.Element => {
  const { descriptor } = session;
  const elapsed = fmtElapsed(descriptor.startedAt, descriptor.finishedAt ?? now);
  // Title is plain-clipped (not Ink-truncated) because chips sit on one row separated by `|`
  // and per-chip truncate-end boxes would each claim flexGrow, fighting each other for width.
  const title =
    descriptor.title.length > maxTitleChars
      ? `${descriptor.title.slice(0, maxTitleChars - 1)}${glyphs.clipEllipsis}`
      : descriptor.title;
  const color = active ? inkColors.highlight : inkColors.muted;
  return (
    <Text color={color} bold={active}>
      [{String(index + 1)}] {glyphs.bullet} {descriptor.flowId}: {title} ⏱{elapsed}
    </Text>
  );
};

export const MultiFlowStrip = ({
  sessions,
  activeId,
  now,
  maxTitleChars = 18,
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
            />
            {i < running.length - 1 && <Text dimColor> {glyphs.pipe}</Text>}
          </Box>
        ))}
      </Box>
      <Text dimColor>{NAV_HINT}</Text>
    </Box>
  );
};
