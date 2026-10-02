/** Inline confirm overlay shown when the operator presses `c` on the Implement view. */

import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useOptionalOverlayState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useClaimKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { isChord } from '@src/application/ui/tui/runtime/key-chord.ts';

/** @public */
export interface CancelScopeOverlayProps {
  /** Wall-clock ms elapsed on the active attempt — drives the "estimated waste" line. */
  readonly attemptElapsedMs: number | undefined;
  /** Tasks still in the queue (including the one currently running). Drives option-2 hint. */
  readonly remainingTaskCount: number;
  /** Operator picked "stop run now" — task stays unsettled, resumes from todo next launch. */
  readonly onCancelAttempt: () => void;
  /** Operator picked "stop run and mark blocked" — task won't resume automatically. */
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
  // `1` / `2` are this overlay's while it is mounted — ambient digit handlers (section jumps)
  // must not also fire on them.
  useClaimKeys(['1', '2']);
  const claimEscape = useOptionalOverlayState()?.claimEscape;
  // Esc closes this overlay only; without the claim the global back handler also pops the view.
  useEffect(() => claimEscape?.(), [claimEscape]);

  // Stable input claim while mounted; the parent view sets `inputActive` props on its own panels to dim them out so
  // they don't compete for the same keystrokes.
  useInput((input, key) => {
    if (isChord(key)) return;
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
            <Text>Stop run now — this task stays unsettled and resumes from todo on the next launch</Text>
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
            <Text>Stop run and mark this task blocked — it won&apos;t resume automatically</Text>
          </Box>
          <Box paddingLeft={4}>
            <Text dimColor>{remainingHint}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
