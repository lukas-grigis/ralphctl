/** Pagination footer shared by the scrollable read-only overlays; renders nothing when the document fits. */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export const DocumentScrollFooter = ({
  offset,
  bodyRows,
  lineCount,
}: {
  readonly offset: number;
  readonly bodyRows: number;
  readonly lineCount: number;
}): React.JSX.Element | null => {
  const maxOffset = Math.max(0, lineCount - bodyRows);
  if (maxOffset === 0) return null;
  return (
    <Box marginTop={spacing.section} justifyContent="space-between">
      <Text dimColor>
        lines {String(offset + 1)}–{String(Math.min(lineCount, offset + bodyRows))} of {String(lineCount)}
      </Text>
      <Text dimColor>
        {glyphs.bullet} ↑/↓ scroll {glyphs.bullet} PgUp/PgDn page
      </Text>
    </Box>
  );
};
