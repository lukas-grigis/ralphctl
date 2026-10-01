/** MemoryPressureBanner — process-wide heap-pressure indicator. */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { MemoryPressureEvent } from '@src/business/observability/events.ts';

const formatMb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(0)} MB`;
const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export const MemoryPressureBanner = (): React.JSX.Element | null => {
  const deps = useDeps();
  const [latest, setLatest] = useState<MemoryPressureEvent | undefined>(undefined);

  useEffect(() => {
    return deps.eventBus.subscribe((event) => {
      if (event.type === 'memory-pressure') setLatest(event);
    });
  }, [deps.eventBus]);

  if (latest === undefined || latest.severity === 'recovered') return null;

  const tone = latest.severity === 'critical' ? inkColors.error : inkColors.warning;
  const headline =
    latest.severity === 'critical'
      ? `memory critical — ${formatPercent(latest.ratio)} of heap; auto-cleared in-memory buffers`
      : `memory pressure — ${formatPercent(latest.ratio)} of heap used; consider aborting and restarting`;
  const detail = `(${formatMb(latest.heapUsed)} / ${formatMb(latest.heapLimit)})`;

  return (
    <Box paddingX={spacing.indent} flexDirection="row">
      <Text bold color={tone}>
        {glyphs.warningGlyph} {headline}
      </Text>
      <Text dimColor> {detail}</Text>
    </Box>
  );
};
