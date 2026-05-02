/**
 * HeaderHeartbeat — persistent activity indicator rendered next to the
 * [RUNNING] chip in the execute view header.
 *
 * Always-visible braille spinner that gives the user a clear "the program
 * is alive" signal even during long AI sessions where the step trace hasn't
 * ticked recently.  The step-level spinner already signals per-step progress;
 * this dot anchors the header without repeating "working…" text.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface HeaderHeartbeatProps {
  /** Frame interval in ms. Default 120. */
  readonly intervalMs?: number;
}

export function HeaderHeartbeat({ intervalMs = 120 }: HeaderHeartbeatProps): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % glyphs.spinner.length);
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);

  return (
    <Box>
      <Text color={inkColors.muted}>{`  ${glyphs.inlineDot}  `}</Text>
      <Text color={inkColors.warning} bold>
        {glyphs.spinner[frame] ?? glyphs.phaseActive}
      </Text>
    </Box>
  );
}
