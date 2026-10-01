/**
 * `FeedbackLine` — the transient inline result line shared by the list / detail views (sprints,
 * projects, project-detail, sessions).
 *
 * Accepts either a structured `{ tone, text }` object (preferred) or a plain string (legacy).
 *
 * Structured form: `tone` drives the glyph prefix and semantic color from tokens — no inline
 * glyphs or string-prefix branching at call sites.
 *
 * Legacy plain-string form: accepted for gradual migration. A leading {@link glyphs.cross}
 * selects the error tone; a leading {@link glyphs.warningGlyph} the warning tone; a leading
 * {@link glyphs.check} the success tone; a leading {@link glyphs.refresh} the info tone; all other strings render in the primary color. Call sites should migrate to the structured form.
 *
 * Renders nothing when `text` is `undefined`, so callers can unconditionally render
 * `<FeedbackLine … />` without a conditional guard.
 *
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
   * Feedback content — either:
   *   - A {@link StructuredFeedback} `{ tone, text }` object (preferred).
   *   - A plain string (legacy). A leading `glyphs.cross` triggers error tone; a leading
   *     `glyphs.check` success tone; a leading `glyphs.refresh` info tone; others render primary.
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
  return (
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text color={color}>
        {glyph.length > 0 ? `${glyph} ` : ''}
        {text.text}
      </Text>
    </Box>
  );
};

/**
 * Construct a {@link StructuredFeedback} value. Convenience factory so call sites
 * don't inline the literal object shape.
 *
 * @public
 */
export const feedback = (tone: FeedbackTone, text: string): StructuredFeedback => ({ tone, text });
