/**
 * Aligned label / value rows. `label` column is dim and fixed-width; values render plain so they stand out without
 * the labels having to compete on color.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { FIELD_LABEL_WIDTH, glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export interface Field {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly dim?: boolean;
  /**
   * Optional one-line explanation rendered on the row below the value (indented to align under the value column, dim
   * styled).
   */
  readonly hint?: string;
}

export interface FieldListProps {
  readonly fields: readonly Field[];
  /** Fixed label column width. */
  readonly labelWidth?: number;
}

const padLabel = (label: string, width: number): string => {
  // Width-based clip on an over-wide label — appends `clipEllipsis` (audit-[03] display-clip marker) so the operator
  // sees the label was abbreviated rather than silently misspelled.
  const trimmed = label.length > width - 1 ? `${label.slice(0, width - 2)}${glyphs.clipEllipsis}` : label;
  const withColon = `${trimmed}:`;
  return withColon.padEnd(width, ' ');
};

/** Compute the label column width from the field set when no explicit width was given. */
const resolveWidth = (fields: readonly Field[], explicit?: number): number => {
  if (explicit !== undefined) return explicit;
  if (fields.length === 0) return FIELD_LABEL_WIDTH;
  const maxLen = fields.reduce((m, f) => Math.max(m, f.label.length), 0);
  return Math.max(FIELD_LABEL_WIDTH, maxLen + 2);
};

export const FieldList = ({ fields, labelWidth }: FieldListProps): React.JSX.Element => {
  const width = resolveWidth(fields, labelWidth);
  return (
    <Box flexDirection="column">
      {fields.map((f, i) => (
        <Box key={`${f.label}-${String(i)}`} flexDirection="column">
          <Box>
            <Box flexShrink={0}>
              <Text dimColor>{padLabel(f.label, width)}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              {typeof f.value === 'string' || typeof f.value === 'number' ? (
                <Text dimColor={f.dim ?? false}>{f.value}</Text>
              ) : (
                f.value
              )}
            </Box>
          </Box>
          {f.hint !== undefined && (
            <Box paddingLeft={width}>
              <Text dimColor italic>
                {f.hint}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};
