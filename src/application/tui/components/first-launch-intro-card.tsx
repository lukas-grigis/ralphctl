/**
 * FirstLaunchIntroCard — welcome surface rendered above the project-add
 * form when the user has no projects yet.
 *
 * Visual: a single bordered info card above the form so the user
 * understands *why* they were routed straight to project-add instead of
 * the home pipeline.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';

export function FirstLaunchIntroCard(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box>
        <Text color={inkColors.info} bold>
          {glyphs.infoGlyph}
        </Text>
        <Text color={inkColors.info} bold>
          {'  Welcome to ralphctl'}
        </Text>
      </Box>
      <Box paddingLeft={spacing.indent} marginTop={spacing.section}>
        <Text dimColor>Add your first project to get started.</Text>
      </Box>
    </Box>
  );
}
