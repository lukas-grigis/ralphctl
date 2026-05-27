/**
 * Footer hint bar for the sprint-detail view — the dim line at the bottom of the body that
 * lists the global navigation chords (`↑/↓ focus`, `↵/o expand`, `n flows`, `esc back`).
 *
 * Kept separate from the orchestrator so the copy lives next to the keymap that drives it
 * (see `shortcuts.ts`) and any future tweak doesn't require touching the main view file.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export const ActionBar = (): React.JSX.Element => (
  <Box paddingX={spacing.indent} marginTop={spacing.section}>
    <Text dimColor>
      {glyphs.bullet} ↑/↓ focus {glyphs.bullet} ↵/o expand/collapse {glyphs.bullet} n flows {glyphs.bullet} esc back
    </Text>
  </Box>
);
