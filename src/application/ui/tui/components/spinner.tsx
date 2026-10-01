/** Braille spinner — leaf component that owns its own frame state. */

import React from 'react';
import { Text } from 'ink';
import { spinnerGlyph, useSpinnerFrame } from '@src/application/ui/tui/runtime/use-spinner-frame.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export interface SpinnerProps {
  readonly label?: string;
  readonly color?: string;
  /** When false the timer is paused — the glyph stays on its current frame. Defaults to true. */
  readonly active?: boolean;
  /** Render with `dimColor` instead of the explicit `color`. */
  readonly dim?: boolean;
}

export const Spinner = ({ label, color = inkColors.info, active = true, dim }: SpinnerProps): React.JSX.Element => {
  const frame = useSpinnerFrame(active);
  const glyph = spinnerGlyph(frame);
  if (dim === true) {
    return (
      <Text dimColor>
        {glyph}
        {label !== undefined && label.length > 0 ? ` ${label}` : ''}
      </Text>
    );
  }
  return (
    <Text color={color}>
      {glyph}
      {label !== undefined && label.length > 0 ? ` ${label}` : ''}
    </Text>
  );
};
