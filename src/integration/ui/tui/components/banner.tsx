/**
 * Banner — gradient-rendered RALPHCTL wordmark + Ralph quote.
 *
 * Rendering note: the canonical banner ASCII art (in `theme/index.ts`) is
 * already pre-coloured with `gradient-string` ANSI escapes. Ink's `<Text>`
 * passes ANSI through unchanged, so we simply emit the string. We deliberately
 * do not re-apply Ink's `color` prop on top — that would clash with the
 * embedded gradient codes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { banner, gradients, getRandomQuote } from '@src/integration/ui/theme/theme.ts';
import { spacing } from '@src/integration/ui/theme/tokens.ts';

export function Banner(): React.JSX.Element {
  const colored = gradients.donut.multiline(banner.art);
  const quote = getRandomQuote();

  return (
    <Box flexDirection="column">
      <Box alignItems="center" justifyContent="center">
        <Text>{colored}</Text>
      </Box>
      <Box marginTop={spacing.section} paddingLeft={spacing.indent}>
        <Text dimColor italic>
          🍩 &quot;{quote}&quot;
        </Text>
      </Box>
    </Box>
  );
}
