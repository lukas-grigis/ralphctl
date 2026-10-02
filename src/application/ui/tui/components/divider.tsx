/**
 * Horizontal rule. Two variants: a thin section rule (used inside cards) and a heavy stamp
 * rule (used to separate the banner from the body). Color stays in the muted band so it doesn't
 * compete with content.
 */

import React from 'react';
import { Text, useStdout } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export interface DividerProps {
  readonly char?: string;
  readonly color?: string;
  readonly inset?: number;
}

export const Divider = ({ char = '─', color = inkColors.rule, inset = 0 }: DividerProps): React.JSX.Element => {
  const { stdout } = useStdout();
  const cols = Math.max(20, stdout?.columns ?? 80);
  const width = Math.max(1, cols - inset * 2);
  return (
    <Text color={color} dimColor>
      {char.repeat(width)}
    </Text>
  );
};
