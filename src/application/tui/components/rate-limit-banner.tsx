/**
 * RateLimitBanner — shown when the rate-limit coordinator has paused new
 * task launches globally. Disappears when the coordinator resumes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';

interface Props {
  readonly visible: boolean;
  readonly message?: string;
}

export function RateLimitBanner({ visible, message }: Props): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Box borderStyle="round" borderColor={inkColors.warning} paddingX={spacing.cardPadX} marginTop={spacing.section}>
      <Text color={inkColors.warning} bold>
        ⚠ Rate limit reached{message ? ` — ${message}` : ''}. Waiting to resume…
      </Text>
    </Box>
  );
}
