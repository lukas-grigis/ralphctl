/**
 * ChainLogDegradedBanner — surfaces a one-shot, latched warning when the persistent
 * `<sprintDir>/chain.log` sink reports it can no longer keep up. The sink only publishes
 * `chain-log-degraded` on its first overflow / first write failure (see file-log-sink.ts);
 * this banner mirrors that contract — it flips on at the first event and never clears
 * until the TUI restarts. Auto-clear would let a transient stall hide the fact that the
 * on-disk postmortem trace is incomplete, which is the exact failure mode the banner
 * exists to surface.
 *
 * Renders nothing while the chain log is healthy. Once latched, renders a single-line
 * warning strip — minimal screen real estate so it doesn't fight with the rest of the
 * chrome. The strip itself stays brief because the actionable detail (which sprint, which
 * reason) belongs in the JSONL on disk, not the banner.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export const ChainLogDegradedBanner = (): React.JSX.Element | null => {
  const deps = useDeps();
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    const unsub = deps.eventBus.subscribe((event) => {
      if (event.type === 'chain-log-degraded') setDegraded(true);
    });
    return unsub;
  }, [deps.eventBus]);

  if (!degraded) return null;

  return (
    <Box paddingX={spacing.indent} flexDirection="row">
      <Text bold color={inkColors.warning}>
        {glyphs.warningGlyph} chain log degraded — postmortem trace may be incomplete
      </Text>
    </Box>
  );
};
