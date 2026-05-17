/**
 * Inline rendering of a hint set: `↵ select  ·  esc back`. Used inside the status bar and
 * occasionally inside cards for local affordances.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

export interface KeyboardHintsProps {
  readonly hints: readonly ViewHint[];
  readonly separator?: string;
}

export const KeyboardHints = ({ hints, separator = ` ${glyphs.bullet} ` }: KeyboardHintsProps): React.JSX.Element => {
  if (hints.length === 0) return <Text dimColor />;
  return (
    <Box>
      {hints.map((h, i) => (
        <Box key={`${h.label}-${String(i)}`}>
          {i > 0 && <Text dimColor>{separator}</Text>}
          <Text color={inkColors.primary} bold>
            {h.keys}
          </Text>
          <Text dimColor> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
};
