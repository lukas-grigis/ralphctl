/**
 * Aligned label / value rows. `label` column is dim and fixed-width; values render plain so they
 * stand out without the labels having to compete on color.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { FIELD_LABEL_WIDTH } from '@src/application/ui/tui/theme/tokens.ts';

export interface Field {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly dim?: boolean;
  /**
   * Optional one-line explanation rendered on the row below the value (indented to align under
   * the value column, dim styled). Use for setting cards where a bare number isn't
   * self-descriptive — e.g. "Max turns: 5" benefits from "Cap on gen/eval iterations per attempt."
   */
  readonly hint?: string;
}

export interface FieldListProps {
  readonly fields: readonly Field[];
  readonly labelWidth?: number;
}

const padLabel = (label: string, width: number): string => {
  const trimmed = label.length > width - 1 ? label.slice(0, width - 1) : label;
  const withColon = `${trimmed}:`;
  return withColon.padEnd(width, ' ');
};

export const FieldList = ({ fields, labelWidth = FIELD_LABEL_WIDTH }: FieldListProps): React.JSX.Element => (
  <Box flexDirection="column">
    {fields.map((f, i) => (
      <Box key={`${f.label}-${String(i)}`} flexDirection="column">
        <Box>
          <Text dimColor>{padLabel(f.label, labelWidth)}</Text>
          <Box>
            {typeof f.value === 'string' || typeof f.value === 'number' ? (
              <Text dimColor={f.dim ?? false}>{f.value}</Text>
            ) : (
              f.value
            )}
          </Box>
        </Box>
        {f.hint !== undefined && (
          <Box paddingLeft={labelWidth}>
            <Text dimColor italic>
              {f.hint}
            </Text>
          </Box>
        )}
      </Box>
    ))}
  </Box>
);
