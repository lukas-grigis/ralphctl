/**
 * FieldList — aligned label/value rows. Labels dim + colon-suffixed + padded
 * to a fixed width so columns line up; values keep normal foreground weight.
 *
 * Used by ResultCard and detail views. The canonical replacement for the
 * plain-CLI `field()` helper when rendering inside Ink.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { FIELD_LABEL_WIDTH } from '@src/integration/ui/theme/tokens.ts';

export type FieldEntry = readonly [label: string, value: string];

interface FieldListProps {
  readonly fields: readonly FieldEntry[];
  /** Override the default label column width (default 12). */
  readonly labelWidth?: number;
}

export function FieldList({ fields, labelWidth = FIELD_LABEL_WIDTH }: FieldListProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {fields.map(([label, value]) => (
        <Box key={label}>
          <Text dimColor>{(label + ':').padEnd(labelWidth)}</Text>
          <Text>{` ${value}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
