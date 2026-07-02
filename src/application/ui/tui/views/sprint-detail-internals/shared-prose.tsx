/**
 * Prose primitives shared by the sprint-detail ticket and task panes.
 *
 * `Section` is a sub-heading + indented block; `Description` is the markdown-light renderer that
 * both ticket and task cards use to clip a free-text field down to a screen-friendly excerpt.
 * Kept in their own file so neither `ticket-list.tsx` nor `task-summary.tsx` has to take a
 * dependency on the other just to share a couple of rendering helpers.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

const DESCRIPTION_MAX_LINES = 3;

export const Section = ({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" marginTop={spacing.section}>
    <Text bold dimColor>
      {glyphs.bullet} {heading}
    </Text>
    {/* marginTop={0} — no spacing token for "none"; left as a literal. */}
    <Box marginTop={0}>{children}</Box>
  </Box>
);

/**
 * Description block — markdown-light: strips `**bold**` markers and bullet prefixes so the
 * source string renders cleanly inside a TUI. Caps visible lines unless the caller passes
 * `Number.POSITIVE_INFINITY` (detail view wants the whole text).
 */
export const Description = ({
  text,
  maxLines = DESCRIPTION_MAX_LINES,
}: {
  readonly text: string;
  readonly maxLines?: number;
}): React.JSX.Element | null => {
  const lines = text
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*]\s+/, '')
        .trimEnd()
    )
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const shown = Number.isFinite(maxLines) ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column" paddingLeft={spacing.indent}>
      {shown.map((line, idx) => (
        <Text key={`${String(idx)}:${line.slice(0, 16)}`} dimColor>
          {line}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor>
          {glyphs.bullet} +{String(hidden)} more line{hidden === 1 ? '' : 's'}
        </Text>
      )}
    </Box>
  );
};
