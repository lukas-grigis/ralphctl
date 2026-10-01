/**
 * `FeedbackLine` — the transient inline result line shared by the list / detail views (sprints, projects,
 * project-detail, sessions).
 * @public
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';

export type FeedbackTone = 'success' | 'warning' | 'error' | 'info';

export interface StructuredFeedback {
  readonly tone: FeedbackTone;
  readonly text: string;
}

export interface FeedbackLineProps {
  /**
   * Feedback content — a {@link StructuredFeedback} `{ tone, text }` (preferred) or a legacy plain string whose leading
   * glyph (cross / check / refresh) picks the tone.
   */
  readonly text: string | StructuredFeedback | undefined;
}

const toneConfig = (tone: FeedbackTone): { glyph: string; color: string } => {
  switch (tone) {
    case 'success':
      return tones.success;
    case 'warning':
      return tones.warning;
    case 'error':
      return tones.error;
    case 'info':
      return { glyph: glyphs.refresh, color: tones.info.color };
  }
};

const resolveStructured = (raw: string): { color: string; body: string } => {
  if (raw.startsWith(glyphs.cross)) return { color: tones.error.color, body: raw };
  if (raw.startsWith(glyphs.warningGlyph)) return { color: tones.warning.color, body: raw };
  if (raw.startsWith(glyphs.refresh)) return { color: tones.info.color, body: raw };
  if (raw.startsWith(glyphs.check)) return { color: tones.success.color, body: raw };
  return { color: inkColors.primary, body: raw };
};

export const FeedbackLine = ({ text }: FeedbackLineProps): React.JSX.Element | null => {
  if (text === undefined) return null;

  if (typeof text === 'string') {
    const { color, body } = resolveStructured(text);
    return (
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text color={color}>{body}</Text>
      </Box>
    );
  }

  // Structured form
  const { glyph, color } = toneConfig(text.tone);
  // Callers often pass text that already leads with a status glyph; the tone supplies one, so never double it.
  const body = glyph.length > 0 && text.text.startsWith(`${glyph} `) ? text.text.slice(glyph.length + 1) : text.text;
  return (
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text color={color}>
        {glyph.length > 0 ? `${glyph} ` : ''}
        {body}
      </Text>
    </Box>
  );
};

/**
 * Construct a {@link StructuredFeedback} value. Convenience factory so call sites don't inline the literal object
 * shape.
 * @public
 */
export const feedback = (tone: FeedbackTone, text: string): StructuredFeedback => ({ tone, text });
