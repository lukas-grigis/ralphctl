/**
 * Card — a bordered, padded container. The default border colour is the muted rule tone so the
 * card recedes; set `tone` to highlight a card that should grab attention (active session,
 * error state, primary CTA).
 *
 * The border defaults to dim only for the `rule` tone (the recessive default). Other tones
 * are explicitly highlighting something, so dimming their border would defeat the purpose; an
 * explicit `dim` prop still wins when the caller wants to override.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { inkColors, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';

export type CardTone = 'rule' | 'primary' | 'info' | 'success' | 'warning' | 'error';

const BORDER: Readonly<Record<CardTone, string>> = {
  rule: inkColors.rule,
  primary: inkColors.primary,
  info: tones.info.color,
  success: tones.success.color,
  warning: tones.warning.color,
  error: tones.error.color,
};

export interface CardProps {
  readonly title?: string;
  readonly tone?: CardTone;
  readonly dim?: boolean;
  readonly children: React.ReactNode;
  readonly right?: React.ReactNode;
  /** Dim text straight after the title (e.g. `— completed`). */
  readonly titleNote?: React.ReactNode;
}

export const Card = ({ title, tone = 'rule', dim, right, titleNote, children }: CardProps): React.JSX.Element => {
  const effectiveDim = dim ?? tone === 'rule';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BORDER[tone]}
      borderDimColor={effectiveDim}
      paddingX={spacing.cardPadX}
      paddingY={0}
    >
      {title !== undefined && (
        <Box justifyContent="space-between">
          <Text>
            <Text color={BORDER[tone]} bold>
              {title}
            </Text>
            {titleNote}
          </Text>
          {right}
        </Box>
      )}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
};
