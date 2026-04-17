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

export function Banner(): React.JSX.Element {
  const colored = gradients.donut.multiline(banner.art);
  const quote = getRandomQuote();

  return (
    <Box flexDirection="column">
      <Text>{colored}</Text>
      <Box marginTop={1} paddingLeft={5}>
        <Text dimColor italic>
          🍩 &quot;{quote}&quot;
        </Text>
      </Box>
    </Box>
  );
}
