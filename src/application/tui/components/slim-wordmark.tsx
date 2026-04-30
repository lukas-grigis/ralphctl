/**
 * SlimWordmark — single-line `🍩 RALPHCTL` rendered at the top of every
 * non-Home view via ViewShell.
 *
 * Why: ViewShell used to render the full block-letter Banner on every view,
 * which ate ~10 rows of screen real estate on small terminals. Home keeps
 * the full Banner; every other view gets this slim wordmark instead — same
 * eye anchor, one row tall.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';

export function SlimWordmark(): React.JSX.Element {
  return (
    <Box marginBottom={spacing.section}>
      <Text>
        🍩{' '}
        <Text color={inkColors.primary} bold>
          RALPHCTL
        </Text>
      </Text>
    </Box>
  );
}
