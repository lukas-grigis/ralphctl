/** ListCard — the shared frame for a card in a vertical list (tickets, tasks). */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useScrollAnchor } from '@src/application/ui/tui/components/scroll-region.tsx';

export interface ListCardProps {
  readonly focused: boolean;
  readonly rightSlot?: React.ReactNode;
  readonly indexLabel?: string;
  readonly title: React.ReactNode;
  readonly children?: React.ReactNode;
}

export const ListCard = ({ focused, rightSlot, indexLabel, title, children }: ListCardProps): React.JSX.Element => {
  // The anchor lives on the shared frame so every list built on it scrolls to follow the cursor.
  const anchorRef = useScrollAnchor(focused);
  return (
    // Column wrapper so the Card stretches to the full width instead of shrinking to its content.
    <Box ref={anchorRef} flexDirection="column" marginBottom={spacing.section}>
      <Card tone={focused ? 'info' : 'rule'}>
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Box justifyContent="space-between">
            <Box>
              <Text {...(focused ? { color: inkColors.primary } : { dimColor: true })}>
                {focused ? `${glyphs.actionCursor} ` : `  `}
                {indexLabel}
              </Text>
              <Text bold>
                {indexLabel !== undefined ? ' ' : ''}
                {title}
              </Text>
            </Box>
            {rightSlot !== undefined && <Box>{rightSlot}</Box>}
          </Box>
          {children}
        </Box>
      </Card>
    </Box>
  );
};
