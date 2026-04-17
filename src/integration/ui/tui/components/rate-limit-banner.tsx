/**
 * RateLimitBanner — visible only while the RateLimitCoordinator has paused
 * new task launches. Running tasks keep going; this banner just tells the
 * user why the queue isn't advancing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';

interface Props {
  pausedSince: Date | null;
  delayMs: number;
}

export function RateLimitBanner({ pausedSince, delayMs }: Props): React.JSX.Element | null {
  if (!pausedSince) return null;
  const seconds = Math.max(0, Math.round(delayMs / 1000));
  return (
    <Box
      borderStyle="round"
      borderColor={inkColors.warning}
      paddingX={1}
    >
      <Text color={inkColors.warning} bold>
        ⚠ Rate limit hit
      </Text>
      <Text dimColor>
        {' — new tasks paused'}
        {seconds > 0 ? ` (~${String(seconds)}s)` : ''}
        {'. Running tasks continue.'}
      </Text>
    </Box>
  );
}
