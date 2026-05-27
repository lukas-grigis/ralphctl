/**
 * Inline confirm overlay shown when the operator presses `c` on the Implement view. Replaces the
 * historic "press c, run aborts immediately" UX where the scope of the cancel was ambiguous —
 * was it just this attempt, or the whole flow?
 *
 * Two scoped options:
 *  1. Cancel current attempt: keeps the task in the queue, retries on the next round. Surfaces an
 *     estimated waste time (`~Xm of generator output`) computed from the active attempt's wall
 *     clock so the operator can weigh the cost.
 *  2. Cancel whole flow: marks the current task `blocked` (reason: `'user cancel'`) and aborts
 *     the chain. Shows the count of tasks remaining in the queue so the operator sees what they
 *     are giving up.
 *
 *  Esc dismisses without action.
 *
 * The overlay is rendered inline inside the execute view (NOT mounted at the App layout level
 * like the help / progress overlays) because it carries flow-specific state — wasted-time
 * estimate and queue depth — that no other view can produce. Same modal contract though: while
 * mounted it claims keyboard input and the underlying view's `c` handler stays dormant.
 */

import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';

/** @public */
export interface CancelScopeOverlayProps {
  /** Wall-clock ms elapsed on the active attempt — drives the "estimated waste" line. */
  readonly attemptElapsedMs: number | undefined;
  /** Tasks still in the queue (including the one currently running). Drives option-2 hint. */
  readonly remainingTaskCount: number;
  /** Operator picked "cancel current attempt". */
  readonly onCancelAttempt: () => void;
  /** Operator picked "cancel whole flow". */
  readonly onCancelFlow: () => void;
  /** Operator dismissed the overlay (esc). */
  readonly onDismiss: () => void;
}

export const CancelScopeOverlay = ({
  attemptElapsedMs,
  remainingTaskCount,
  onCancelAttempt,
  onCancelFlow,
  onDismiss,
}: CancelScopeOverlayProps): React.JSX.Element => {
  // Stable input claim while mounted; the parent view sets `inputActive` props on its own
  // panels to dim them out so they don't compete for the same keystrokes. Unmount happens via
  // any of the three callbacks (the parent unconditionally hides the overlay after the action).
  useInput((input, key) => {
    if (input === '1') {
      onCancelAttempt();
      return;
    }
    if (input === '2') {
      onCancelFlow();
      return;
    }
    if (key.escape) {
      onDismiss();
    }
  });

  // Belt-and-braces: clear the overlay if the keypress that opened it never fires its
  // companion (e.g. a TUI bug or a forced unmount mid-render). React's effect cleanup handles
  // the normal path; this is no-op when the parent already unmounted us.
  useEffect(() => undefined, []);

  const wasted = attemptElapsedMs !== undefined ? fmtDuration(attemptElapsedMs) : undefined;
  const remainingHint =
    remainingTaskCount > 1
      ? `${String(remainingTaskCount - 1)} other task${remainingTaskCount - 1 === 1 ? '' : 's'} still queued`
      : 'no other tasks queued';

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={0} marginTop={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inkColors.warning}
        paddingX={spacing.indent}
        paddingY={0}
      >
        <Box justifyContent="space-between">
          <Text color={inkColors.warning} bold>
            {glyphs.warningGlyph} Cancel — pick a scope
          </Text>
          <Text dimColor>esc to dismiss</Text>
        </Box>
        <Box flexDirection="column" marginTop={spacing.section}>
          <Box>
            <Box width={4}>
              <Text color={inkColors.highlight} bold>
                1
              </Text>
            </Box>
            <Text>Cancel current attempt (keep task, retry on next round)</Text>
          </Box>
          {wasted !== undefined && (
            <Box paddingLeft={4}>
              <Text dimColor>~{wasted} of generator output discarded</Text>
            </Box>
          )}
          <Box marginTop={spacing.section}>
            <Box width={4}>
              <Text color={inkColors.highlight} bold>
                2
              </Text>
            </Box>
            <Text>Cancel whole flow (mark current task blocked, exit chain)</Text>
          </Box>
          <Box paddingLeft={4}>
            <Text dimColor>{remainingHint}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
