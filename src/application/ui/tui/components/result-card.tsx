/**
 * Outcome summary card — shown when a chain settles. Encodes the outcome in both the title bar
 * (colour + glyph) and the body (FieldList of relevant metadata), then answers the two questions
 * a settled run leaves open: what to do next, and — on a failure — where to look.
 *
 * Both trailing blocks are supplied by the caller: `nextSteps` from `buildNextSteps`, `forensics`
 * from `useRunForensics` (already existence-checked, so a rendered path always resolves).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import type { Field } from '@src/application/ui/tui/components/field-list.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { NextStepList } from '@src/application/ui/tui/components/next-steps.tsx';
import type { ForensicPath, NextStep } from '@src/application/ui/shared/next-steps.ts';
import { Card, type CardTone } from '@src/application/ui/tui/components/card.tsx';

export type ResultKind = 'success' | 'failed' | 'aborted';

export interface ResultCardProps {
  readonly kind: ResultKind;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly fields?: readonly Field[];
  readonly nextSteps?: readonly NextStep[];
  /** Post-mortem artifacts. Empty / omitted ⇒ the block is not rendered at all. */
  readonly forensics?: readonly ForensicPath[];
}

const RESOLVE: Readonly<
  Record<ResultKind, { readonly tone: CardTone; readonly glyph: string; readonly verb: string }>
> = {
  success: { tone: 'success', glyph: tones.success.glyph, verb: 'completed' },
  failed: { tone: 'error', glyph: tones.error.glyph, verb: 'failed' },
  aborted: { tone: 'warning', glyph: tones.warning.glyph, verb: 'aborted' },
};

export const ResultCard = ({
  kind,
  title,
  summary,
  fields,
  nextSteps,
  forensics,
}: ResultCardProps): React.JSX.Element => {
  const meta = RESOLVE[kind];
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Card
        tone={meta.tone}
        dim={false}
        title={`${meta.glyph} ${title}`}
        titleNote={
          <Text dimColor>
            {' '}
            {glyphs.emDash} {meta.verb}
          </Text>
        }
      >
        {summary !== undefined && summary.length > 0 && (
          <Box marginTop={spacing.section}>
            <Text>{summary}</Text>
          </Box>
        )}
        {fields !== undefined && fields.length > 0 && (
          <Box marginTop={spacing.section}>
            <FieldList fields={fields} />
          </Box>
        )}
        {nextSteps !== undefined && nextSteps.length > 0 && (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              Next steps
            </Text>
            <NextStepList steps={nextSteps} />
          </Box>
        )}
        {forensics !== undefined && forensics.length > 0 && (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              Post-mortem
            </Text>
            <FieldList fields={forensics.map((f) => ({ label: f.label, value: f.path, dim: true }))} />
          </Box>
        )}
      </Card>
    </Box>
  );
};
