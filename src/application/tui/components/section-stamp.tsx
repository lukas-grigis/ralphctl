/**
 * SectionStamp — the "letterpress" header that opens every workflow / view.
 *
 * Renders as: `▣ CREATE SPRINT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
 *
 * Bold primary-color badge glyph + all-caps title. Gives each view an
 * unmistakable origin marker without stealing visual weight from the content.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface SectionStampProps {
  readonly title: string;
  /** Override the accent color; defaults to brand primary. */
  readonly color?: string;
}

export function SectionStamp({ title, color = inkColors.primary }: SectionStampProps): React.JSX.Element {
  return (
    <Box>
      <Text color={color} bold>
        {glyphs.badge}
      </Text>
      <Text color={color} bold>{` ${title.toUpperCase()}`}</Text>
    </Box>
  );
}
