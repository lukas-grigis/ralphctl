/**
 * PullQuote — Ralph-personality quote with a heavy left rail.
 *
 * Renders as:
 *   `┃  "I'm helping!"`
 *
 * Use sparingly — banner, successful completion of a workflow, similar seams.
 * Personality moments, not load-bearing UI.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

export interface PullQuoteProps {
  readonly text: string;
}

export function PullQuote({ text }: PullQuoteProps): React.JSX.Element {
  return (
    <Box>
      <Text color={inkColors.secondary}>{glyphs.quoteRail}</Text>
      <Text dimColor italic>
        {`  "${text}"`}
      </Text>
    </Box>
  );
}
