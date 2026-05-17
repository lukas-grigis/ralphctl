/**
 * Section-stamp — the title row that anchors every view. A small badge glyph + bold title +
 * dim subtitle, capped with a thin separator rule so the eye knows where the title ends.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface SectionStampProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  /** Right-aligned slot, e.g. a status chip or `n of m` counter. */
  readonly right?: React.ReactNode;
}

export const SectionStamp = ({ title, subtitle, right }: SectionStampProps): React.JSX.Element => (
  <Box flexDirection="column" marginBottom={spacing.section}>
    <Box justifyContent="space-between" paddingX={spacing.indent}>
      <Box>
        <Text color={inkColors.primary} bold>
          {glyphs.badge}{' '}
        </Text>
        <Text bold>{title}</Text>
        {subtitle !== undefined && subtitle.length > 0 && (
          <Text dimColor>
            {' '}
            {glyphs.emDash} {subtitle}
          </Text>
        )}
      </Box>
      {right !== undefined && <Box>{right}</Box>}
    </Box>
  </Box>
);
