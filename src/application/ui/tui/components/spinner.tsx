/**
 * Braille spinner. Reads the shared frame counter so multiple spinners on the same screen tick
 * in sync.
 */

import React from 'react';
import { Text } from 'ink';
import { useSpinnerFrame, spinnerGlyph } from '@src/application/ui/tui/runtime/use-spinner-frame.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export interface SpinnerProps {
  readonly label?: string;
  readonly color?: string;
}

export const Spinner = ({ label, color = inkColors.info }: SpinnerProps): React.JSX.Element => {
  const frame = useSpinnerFrame();
  return (
    <Text color={color}>
      {spinnerGlyph(frame)}
      {label !== undefined && label.length > 0 ? ` ${label}` : ''}
    </Text>
  );
};
