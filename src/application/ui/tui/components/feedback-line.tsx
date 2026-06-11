/**
 * `FeedbackLine` — the transient inline result line shared by the list / detail views (sprints,
 * projects, project-detail). Each rendered the same indented `<Box>` with a colour ternary:
 * error tone when the message starts with the cross glyph, primary tone otherwise.
 *
 * Centralising it also retires an inline-glyph violation — the views compared against a literal
 * `'✗'`; the canonical token is `glyphs.cross`, used here for the prefix test.
 *
 * Renders nothing when `text` is `undefined`, so callers drop the previous
 * `text !== undefined && (<Box>…</Box>)` guard.
 *
 * @public
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface FeedbackLineProps {
  /** Resolved feedback text. A leading {@link glyphs.cross} tints the line error-red. */
  readonly text: string | undefined;
}

export const FeedbackLine = ({ text }: FeedbackLineProps): React.JSX.Element | null => {
  if (text === undefined) return null;
  return (
    <Box paddingX={spacing.indent} marginTop={1}>
      <Text color={text.startsWith(glyphs.cross) ? inkColors.error : inkColors.primary}>{text}</Text>
    </Box>
  );
};
