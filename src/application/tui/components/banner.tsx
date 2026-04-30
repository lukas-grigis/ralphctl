/**
 * Banner — gradient-rendered RALPHCTL wordmark + Ralph quote.
 *
 * The canonical banner ASCII art (in `theme/theme.ts`) is rendered through
 * `gradients.donut.multiline()` which embeds ANSI escape codes. Ink's
 * `<Text>` passes ANSI through unchanged, so we emit the coloured string
 * directly and deliberately avoid stacking Ink's `color` prop on top — that
 * would clash with the embedded gradient codes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { banner, gradients, getRandomQuote } from '../../../integration/ui/theme/theme.ts';
import { inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';

// Stabilised at module load: the banner now renders on every view via
// ViewShell, and a re-rolling quote on each navigation would jitter
// distractingly. One quote per process — refreshes on app restart, same as
// the legacy banner did.
const STABLE_ART = gradients.donut.multiline(banner.art);
const STABLE_QUOTE = getRandomQuote();

export function Banner(): React.JSX.Element {
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
        <Text>{STABLE_ART}</Text>
      </Box>
      <Box marginTop={spacing.section} alignItems="center" justifyContent="center">
        <Text dimColor italic>
          🍩 &quot;{STABLE_QUOTE}&quot;
        </Text>
      </Box>
    </Box>
  );
}
