/**
 * ResultCard — Ink equivalent of the plain-CLI `showSuccess` / `showError` /
 * `showWarning` + `field` + `showNextStep` combo.
 *
 * Visual language: a colored glyph + bold title, optional aligned field list
 * (via `<FieldList />`), optional dim body lines, optional next-step rows
 * with a distinctive right-arrow cursor.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { FieldList, type FieldEntry } from './field-list.tsx';

type ResultKind = 'success' | 'error' | 'warning' | 'info';

interface ResultNextStep {
  readonly action: string;
  readonly description?: string;
}

interface ResultCardProps {
  readonly kind: ResultKind;
  readonly title: string;
  readonly fields?: readonly FieldEntry[];
  readonly nextSteps?: readonly ResultNextStep[];
  /** Free-form dim lines rendered under the fields (extra paths, hints). */
  readonly lines?: readonly string[];
}

const GLYPH: Record<ResultKind, string> = {
  success: glyphs.check,
  error: glyphs.cross,
  warning: glyphs.warningGlyph,
  info: glyphs.infoGlyph,
};

const COLOR: Record<ResultKind, string> = {
  success: inkColors.success,
  error: inkColors.error,
  warning: inkColors.warning,
  info: inkColors.info,
};

export function ResultCard({ kind, title, fields, nextSteps, lines }: ResultCardProps): React.JSX.Element {
  const color = COLOR[kind];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold>
          {GLYPH[kind]}
        </Text>
        <Text color={color} bold>
          {`  ${title}`}
        </Text>
      </Box>

      {fields && fields.length > 0 ? (
        <Box marginTop={spacing.section}>
          <FieldList fields={fields} />
        </Box>
      ) : null}

      {lines && lines.length > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {nextSteps && nextSteps.length > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text dimColor bold>
            Next
          </Text>
          {nextSteps.map((step, i) => (
            <Box key={i} paddingLeft={spacing.indent}>
              <Text color={inkColors.highlight}>{`${glyphs.arrowRight} `}</Text>
              <Text>{step.action}</Text>
              {step.description ? <Text dimColor>{` ${glyphs.emDash} ${step.description}`}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
