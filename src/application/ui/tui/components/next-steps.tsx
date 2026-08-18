/**
 * Renderer for {@link NextStep} rows — the one visual spelling of "what to do next", shared by
 * the settled `ResultCard`, Home's sprint card, and the Flows orientation card. Keeping the
 * renderer here (rather than one per view) is what makes the three surfaces literally identical
 * instead of merely similar.
 *
 * Row shape: `<key> → <label> (<detail>)`. The key is highlighted (the focus/next treatment from
 * DESIGN-SYSTEM § 2.4); the detail is dim so a count never competes with the action.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { NextStep } from '@src/application/ui/shared/next-steps.ts';

export const NextStepRow = ({ step }: { readonly step: NextStep }): React.JSX.Element => (
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

export interface NextStepListProps {
  readonly steps: readonly NextStep[];
  /**
   * Optional lead-in printed before the first row (`· next: ` on Home, `— next: ` on Flows).
   * Subsequent rows are blank-padded to the same width so a multi-row recommendation (the
   * `review` state emits two) stays aligned under the first.
   */
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
