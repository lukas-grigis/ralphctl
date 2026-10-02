/**
 * Bounded scrolling viewport for the Review-step description body. When the description fits,
 * renders a single `<Text>` so the static output matches the pre-fix rendering. When it
 * overflows, slices a window plus a position indicator and binds ↑/↓ + PgUp/PgDn (no wrap, no
 * line yank, no g/G). The ConfirmPrompt's y/n/↵/esc are unaffected — arrows are exclusively
 * ours, and ConfirmPrompt itself only listens for ←/→/h/l/y/n/↵/esc.
 *
 * When the body fits the viewport, the global `↑/↓ scroll` footer hint is suppressed so the
 * status bar never lies about what arrows do on this screen; when the body overflows, the
 * hint remains because arrows now legitimately scroll the description.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useSuppressGlobalHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

/**
 * Rows of chrome reserved around the scrollable description body when the header is the compact
 * single-line strip (the default for this view below the full-banner width threshold):
 * breadcrumb + section stamp at the top, plus the Title row, the Link row, the spacing gutter,
 * the ConfirmPrompt (message + pills + hint), and the status bar at the bottom. Tuned so a
 * default 24-row terminal scrolls a long body while keeping the Link row and confirm pills in
 * view.
 */
const REVIEW_CHROME_COMPACT = 14;

/**
 * Extra rows the full wordmark banner occupies over the compact strip (round frame + art block
 * + quote rail). On a wide terminal the banner auto-switches to the full frame; reserving only
 * the compact estimate there is the brittle failure this layout replaces — the unaccounted rows
 * let the body grow tall enough to push the Title / Link / confirm rows off the bottom.
 */
const REVIEW_CHROME_FULL_BANNER_EXTRA = 10;

/**
 * Width at/below which the banner renders its compact strip instead of the full wordmark frame.
 * Mirrors the Banner component's own threshold so the chrome reserve tracks what is drawn.
 */
const BANNER_FULL_MIN_WIDTH = 100;

/**
 * Floor on the description viewport. On a terminal too short for a comfortable area the body
 * shrinks to this many rows — still scrollable through the full text — instead of stealing rows
 * from the Title / Link / confirm chrome, so those controls stay visible.
 */
const REVIEW_MIN_VIEWPORT = 4;

interface ReviewScrollableDescriptionProps {
  readonly text: string;
}

export const ReviewScrollableDescription = ({ text }: ReviewScrollableDescriptionProps): React.JSX.Element => {
  const term = useTerminalSize();
  const ui = useUiState();
  const lines = useMemo<readonly string[]>(() => text.split('\n'), [text]);
  // Mirror ViewShell → Banner: the user `b`-toggle forces the compact strip; otherwise the
  // banner auto-switches on width. Reserve the chrome that matches whichever header is actually
  // drawn so the surrounding rows always fit, rather than a single worst-case constant that
  // under-reserves on a wide terminal showing the full banner.
  const bannerIsCompact = ui.bannerCompact || term.columns < BANNER_FULL_MIN_WIDTH;
  const chromeRows = bannerIsCompact ? REVIEW_CHROME_COMPACT : REVIEW_CHROME_COMPACT + REVIEW_CHROME_FULL_BANNER_EXTRA;
  const viewport = Math.max(REVIEW_MIN_VIEWPORT, term.rows - chromeRows);
  const overflows = lines.length > viewport;
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(0);

  // Clamp on resize / line-count change so a window-shrink can't strand the offset past the
  // new bottom.
  useEffect(() => {
    setOffset((o) => Math.max(0, Math.min(o, maxOffset)));
  }, [maxOffset]);

  // Suppress the global ↑/↓ scroll hint while the description fits — arrows are inert and the
  // footer should not advertise them.
  useSuppressGlobalHints(overflows ? [] : ['↑/↓']);

  useInput((_input, key) => {
    if (!overflows) return;
    const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));
    if (key.upArrow) setOffset((o) => clamp(o - 1));
    else if (key.downArrow) setOffset((o) => clamp(o + 1));
    else if (key.pageUp) setOffset((o) => clamp(o - viewport));
    else if (key.pageDown) setOffset((o) => clamp(o + viewport));
  });

  if (!overflows) {
    return <Text>{text}</Text>;
  }

  const visible = lines.slice(offset, offset + viewport);
  const lastVisible = Math.min(offset + viewport, lines.length);
  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={`desc-${String(offset + i)}`}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      <Text dimColor>
        lines {String(offset + 1)}–{String(lastVisible)} of {String(lines.length)}
      </Text>
    </Box>
  );
};
