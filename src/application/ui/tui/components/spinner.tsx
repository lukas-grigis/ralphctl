/**
 * Braille spinner — leaf component that owns its own frame state. The 90 ms `setInterval` lives
 * inside this leaf, so re-renders are isolated to the spinner node and don't reconcile parent
 * subtrees. Critical for views like ExecuteView / TasksPanel that render unbounded child lists:
 * driving the spinner from a parent would tick every list child ~11× per second and OOM Ink's
 * reconciler on long Implement runs.
 *
 * Two render shapes:
 *  - With `label`: glyph + space + label (legacy callers — status bar, loading panels).
 *  - Without `label`: glyph only (used inline inside an existing `<Text>` parent that supplies
 *    surrounding copy and color).
 */

import React from 'react';
import { Text } from 'ink';
import { spinnerGlyph, useSpinnerFrame } from '@src/application/ui/tui/runtime/use-spinner-frame.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export interface SpinnerProps {
  readonly label?: string;
  readonly color?: string;
  /**
   * When false the timer is paused — the glyph stays on its current frame. Keeps the
   * `useSpinnerFrame` interval from firing when the spinner is decorative-only (e.g. a task
   * row that's no longer the running task). Defaults to true.
   */
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
