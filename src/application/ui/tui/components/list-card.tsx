/**
 * ListCard — the shared frame for a card in a vertical list (tickets, tasks). Thin wrapper
 * around {@link Card} that centralises the visual contract — border tone, dim policy, internal
 * padding, marginBottom gutter, and the title row layout (cursor + index + title on the left,
 * status chip on the right). Both TicketCard and TaskCard render through this primitive so they
 * cannot drift.
 *
 * Tone semantics:
 *   focused   → tone='info'  (highlighted border, no dim)
 *   unfocused → tone='rule'  (recessive divider tone, dimmed border)
 *
 * The focused row carries `▸` as text, so focus survives NO_COLOR. Projects, Sprints, Skills,
 * tickets and tasks all use it. Open/closed state is the caller's concern — pass the body via `children`.
 */

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
