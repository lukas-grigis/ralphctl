/**
 * Modal help reference. Renders a card listing every binding by area. The global key handler
 * intercepts `?` to open / close it; while open, every other global key is suspended (only
 * `esc` and `?` close).
 *
 * Per-view local hints (registered via {@link useViewHints}) are surfaced as the top section
 * so the overlay matches what the user can actually press right now. Static sections (global,
 * lists, execute) follow.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { keySections } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { useActiveHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

export const HelpOverlay = (): React.JSX.Element => {
  const localHints = useActiveHints();
  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inkColors.primary}
        paddingX={spacing.indent}
        paddingY={0}
      >
        <Box justifyContent="space-between">
          <Text color={inkColors.primary} bold>
            {glyphs.badge} Keyboard reference
          </Text>
          <Text dimColor>esc · ? to close</Text>
        </Box>
        {localHints.length > 0 && (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text bold>This view</Text>
            {localHints.map((h) => (
              <Box key={`${h.keys}-${h.label}`}>
                <Box width={20}>
                  <Text color={inkColors.highlight}>{h.keys}</Text>
                </Box>
                <Text dimColor>{h.label}</Text>
              </Box>
            ))}
          </Box>
        )}
        {keySections.map((section) => (
          <Box key={section.title} flexDirection="column" marginTop={spacing.section}>
            <Text bold>{section.title}</Text>
            {section.bindings.map((b) => (
              <Box key={b.label}>
                <Box width={20}>
                  <Text color={inkColors.highlight}>{b.keys.join(' · ')}</Text>
                </Box>
                <Text dimColor>{b.label}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
};
