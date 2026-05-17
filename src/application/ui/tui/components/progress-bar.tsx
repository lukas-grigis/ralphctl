/**
 * Compact horizontal progress bar. Used by the home dashboard's "this sprint" summary.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export interface ProgressBarProps {
  /** 0..1 inclusive. Values outside the range are clamped. */
  readonly value: number;
  readonly width?: number;
  readonly color?: string;
  readonly trackColor?: string;
}

export const ProgressBar = ({
  value,
  width,
  color = inkColors.success,
  trackColor = inkColors.rule,
}: ProgressBarProps): React.JSX.Element => {
  const { stdout } = useStdout();
  const cols = Math.max(20, stdout?.columns ?? 80);
  const w = Math.max(4, Math.min(width ?? Math.floor(cols / 3), cols - 4));
  const v = Math.max(0, Math.min(1, value));
  const filled = Math.round(v * w);
  const empty = w - filled;
  return (
    <Box>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text color={trackColor} dimColor>
        {'░'.repeat(empty)}
      </Text>
    </Box>
  );
};
