/**
 * "Nothing here yet" placeholder card. Used when a list is empty so the screen still has a
 * meaningful focal point with a call-to-action.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: string;
  readonly action?: string;
}

export const EmptyState = ({ title, hint, action }: EmptyStateProps): React.JSX.Element => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={inkColors.muted}
    borderDimColor
    paddingX={spacing.indent}
    paddingY={0}
    alignItems="center"
  >
    <Text bold>
      {glyphs.bullet} {title}
    </Text>
    {hint !== undefined && (
      <Text dimColor italic>
        {hint}
      </Text>
    )}
    {action !== undefined && (
      <Box marginTop={spacing.section}>
        <Text color={inkColors.primary} bold>
          {action}
        </Text>
      </Box>
    )}
  </Box>
);
