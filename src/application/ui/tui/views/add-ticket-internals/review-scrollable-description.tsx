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

/**
 * Reserve rows for the chrome around the scrollable description body — banner + breadcrumb +
 * section stamp at the top, plus the Title row, the Link row, the spacing gutter, the
 * ConfirmPrompt (message + pills + hint), and the status bar at the bottom. The exact rows
 * vary with banner mode and terminal width; this constant is the worst-case estimate that
 * keeps the Link row and the confirm pills visible on a default 24-row terminal. Floor on the
 * viewport ensures a tiny terminal still shows something useful.
 */
const REVIEW_CHROME_ROWS = 14;
const REVIEW_MIN_VIEWPORT = 4;

interface ReviewScrollableDescriptionProps {
  readonly text: string;
}

export const ReviewScrollableDescription = ({ text }: ReviewScrollableDescriptionProps): React.JSX.Element => {
  const term = useTerminalSize();
  const lines = useMemo<readonly string[]>(() => text.split('\n'), [text]);
  const viewport = Math.max(REVIEW_MIN_VIEWPORT, term.rows - REVIEW_CHROME_ROWS);
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
