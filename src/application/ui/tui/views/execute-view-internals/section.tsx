/**
 * Section helpers used across the execute view's panels — a bullet-led header strip and a
 * top-margin wrapper that pairs the header with its children. Extracted so the column
 * layouts in `layout.tsx` and the inline single-column branch in the orchestrator both
 * compose the same primitive.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export const SectionHeader = ({ title }: { readonly title: string }): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text dimColor bold>
      {glyphs.bullet} {title}
    </Text>
  </Box>
);

export const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" marginTop={spacing.section}>
    <SectionHeader title={title} />
    {children}
  </Box>
);
