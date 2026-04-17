/**
 * Spinner — braille frame animation for "in flight" workflow states.
 *
 * Animates at 80ms per frame (roughly 12fps) which is slow enough to read
 * and fast enough to feel alive. Uses `setInterval` rather than requestAnimationFrame
 * because Ink reconciles on a timer anyway and we want predictable frame pacing.
 *
 * Renders inline with a trailing label: `⠋ Creating sprint…`
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface SpinnerProps {
  readonly label: string;
  /** Override the frame color; defaults to warning amber. */
  readonly color?: string;
  /** Frame interval in ms. Default 80. */
  readonly intervalMs?: number;
}

export function Spinner({ label, color = inkColors.warning, intervalMs = 80 }: SpinnerProps): React.JSX.Element | null {
  const [frame, setFrame] = useState(0);

  // UI contract (REQUIREMENTS.md § Spinner labels): while a view is idle
  // waiting on a prompt, the prompt owns the visual — don't show a spinner.
  const isAwaitingPrompt = label.startsWith('Awaiting');

  useEffect(() => {
    if (isAwaitingPrompt) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % glyphs.spinner.length);
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs, isAwaitingPrompt]);

  if (isAwaitingPrompt) return null;

  return (
    <Box>
      <Text color={color} bold>
        {glyphs.spinner[frame]}
      </Text>
      <Text>{` ${label}`}</Text>
    </Box>
  );
}
