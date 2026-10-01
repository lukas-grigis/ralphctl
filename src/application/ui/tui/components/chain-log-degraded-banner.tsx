/**
 * The sink only publishes `chain-log-degraded` on its first overflow / first write failure (see file-log-sink.ts);
 * this banner mirrors that contract.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export const ChainLogDegradedBanner = (): React.JSX.Element | null => {
  const deps = useDeps();
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    return deps.eventBus.subscribe((event) => {
      if (event.type === 'chain-log-degraded') setDegraded(true);
    });
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
