/**
 * Renderer for {@link NextStep} rows — the one visual spelling of "what to do next", shared by the settled
 * `ResultCard`, Home's sprint card, and the Flows orientation card.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { NextStep } from '@src/application/ui/shared/next-steps.ts';

export const NextStepRow = ({ step }: { readonly step: NextStep }): React.JSX.Element => {
  if (step.flow !== undefined) {
    return (
      <Text>
        <Text bold color={inkColors.highlight}>
          {glyphs.phaseActive} {step.label}
        </Text>
        {step.detail !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.emDash} {step.detail}
          </Text>
        )}
      </Text>
    );
  }
  return (
    <Text>
      {step.key !== undefined && (
        <>
          <Text bold color={inkColors.highlight}>
            {step.key}
          </Text>
          <Text dimColor> {glyphs.arrowRight} </Text>
        </>
      )}
      <Text>{step.label}</Text>
      {step.detail !== undefined && <Text dimColor> ({step.detail})</Text>}
    </Text>
  );
};

export interface NextStepListProps {
  readonly steps: readonly NextStep[];
  /** Optional lead-in printed before the first row (`· next: ` on Home, `— next: ` on Flows). */
  readonly prefix?: string;
}

export const NextStepList = ({ steps, prefix }: NextStepListProps): React.JSX.Element | null => {
  if (steps.length === 0) return null;
  return (
    <Box flexDirection="column">
      {steps.map((step, i) => (
        <Box key={`${step.label}-${String(i)}`}>
          {prefix !== undefined && <Text dimColor>{i === 0 ? prefix : ' '.repeat(prefix.length)}</Text>}
          <NextStepRow step={step} />
        </Box>
      ))}
    </Box>
  );
};
