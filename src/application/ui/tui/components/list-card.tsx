/**
 * ListCard — the shared frame for a card in a vertical list (tickets, tasks). Thin wrapper
 * around {@link Card} that centralises the visual contract — border tone, dim policy, internal
 * padding, marginBottom gutter, and the title row layout (cursor + index + title on the left,
 * status chip on the right). Both TicketCard and TaskCard render through this primitive so they
 * cannot drift on any of those dimensions.
 *
 * Tone semantics:
 *   focused   → tone='info'  (highlighted border, no dim)
 *   unfocused → tone='rule'  (recessive divider tone, dimmed border)
 *
 * Open/closed state is the caller's concern — pass the expanded / collapsed body via `children`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface ListCardProps {
  readonly focused: boolean;
  readonly rightSlot?: React.ReactNode;
  readonly indexLabel: string;
  readonly title: string;
  readonly children?: React.ReactNode;
}

export const ListCard = ({ focused, rightSlot, indexLabel, title, children }: ListCardProps): React.JSX.Element => (
  // The outer wrapper uses `flexDirection="column"` so the inner Card stretches to the parent
  // column's full width on the cross-axis. A default row wrapper would let the bordered Card
  // shrink to its content width, producing visually mismatched border edges between ticket
  // and task cards stacked in the same section.
  <Box flexDirection="column" marginBottom={spacing.section}>
    <Card tone={focused ? 'info' : 'rule'}>
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Box justifyContent="space-between">
          <Box>
            <Text {...(focused ? { color: inkColors.primary } : { dimColor: true })}>
              {focused ? `${glyphs.actionCursor} ` : `  `}
              {indexLabel}
            </Text>
            <Text bold> {title}</Text>
          </Box>
          {rightSlot !== undefined && <Box>{rightSlot}</Box>}
        </Box>
        {children}
      </Box>
    </Card>
  </Box>
);
