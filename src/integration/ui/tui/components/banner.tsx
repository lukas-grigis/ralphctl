/**
 * Banner — gradient-rendered RALPHCTL wordmark + Ralph quote.
 *
 * Rendering note: the canonical banner ASCII art (in `theme/index.ts`) is
 * already pre-coloured with `gradient-string` ANSI escapes. Ink's `<Text>`
 * passes ANSI through unchanged, so we simply emit the string. We deliberately
 * do not re-apply Ink's `color` prop on top — that would clash with the
 * embedded gradient codes.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { banner, gradients, getRandomQuote } from '@src/integration/ui/theme/theme.ts';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

export function Banner(): React.JSX.Element {
  // Memoize once per mount: the gradient is pure but non-trivial, and the
  // quote is random — without this it would reshuffle on every parent render.
  const colored = useMemo(() => gradients.donut.multiline(banner.art), []);
  const quote = useMemo(() => getRandomQuote(), []);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.primary}
      borderDimColor
      paddingX={spacing.indent}
      paddingY={spacing.section}
      marginBottom={spacing.section}
    >
      <Box alignItems="center" justifyContent="center">
        <Text>{colored}</Text>
      </Box>
      <Box marginTop={spacing.section} alignItems="center" justifyContent="center">
        <Text dimColor italic>
          🍩 &quot;{quote}&quot;
        </Text>
      </Box>
    </Box>
  );
}
