/**
 * Bounded scrolling viewport for the Review-step description body. When the description fits, renders a single
 * `<Text>` so the static output matches the pre-fix rendering.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useSuppressGlobalHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { bannerRows, resolveBannerMode } from '@src/application/ui/tui/components/banner.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

/**
 * Rows of chrome reserved around the scrollable description body, before any wordmark rows.
 */
const REVIEW_CHROME_COMPACT = 14;

/** Floor on the description viewport. */
const REVIEW_MIN_VIEWPORT = 4;

interface ReviewScrollableDescriptionProps {
  readonly text: string;
}

export const ReviewScrollableDescription = ({ text }: ReviewScrollableDescriptionProps): React.JSX.Element => {
  const term = useTerminalSize();
  const ui = useUiState();
  const router = useRouter();
  const lines = useMemo<readonly string[]>(() => text.split('\n'), [text]);
  const chromeRows =
    REVIEW_CHROME_COMPACT +
    bannerRows(
      resolveBannerMode({
        routeId: router.current.id,
        columns: term.columns,
        rows: term.rows,
        userToggle: ui.bannerCompact,
      }),
      term.columns
    );
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
