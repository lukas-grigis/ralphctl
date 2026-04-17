/**
 * SectionStamp — the "letterpress" header that opens every workflow / view.
 *
 * Renders as:
 *   `▣ CREATE SPRINT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
 *
 * Bold primary-color badge glyph + all-caps title + a trailing em-rule that
 * fills the remaining width. Gives each view an unmistakable origin marker
 * without stealing visual weight from the content below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

export interface SectionStampProps {
  readonly title: string;
  /** Visible width for the trailing rule. Defaults to a sensible 72 cols. */
  readonly width?: number;
  /** Override the accent color; defaults to brand primary. */
  readonly color?: string;
}

const DEFAULT_WIDTH = 72;
const MIN_RULE = 3;

export function SectionStamp({ title, width = DEFAULT_WIDTH, color = inkColors.primary }: SectionStampProps): React.JSX.Element {
  const upper = title.toUpperCase();
  // +3 accounts for badge glyph, space before title, space after title.
  const consumed = 3 + upper.length;
  const ruleLen = Math.max(MIN_RULE, width - consumed);
  const rule = glyphs.sectionRule.repeat(ruleLen);

  return (
    <Box>
      <Text color={color} bold>
        {glyphs.badge}
      </Text>
      <Text color={color} bold>{` ${upper} `}</Text>
      <Text color={color} dimColor>
        {rule}
      </Text>
    </Box>
  );
}
