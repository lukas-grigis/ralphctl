/**
 * ScrollRegion — when the clip edge cuts through a bordered box, the overflow cue rides inside a re-drawn border row
 * instead of replacing the box's real border with a bare `▾ N more`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const lines = (n: number): React.JSX.Element[] =>
  Array.from({ length: n }, (_u, i) => <Text key={i}>{`row ${String(i + 1)}`}</Text>);

describe('ScrollRegion — cue inside a clipped box', () => {
  it('closes a cut bordered box with a border row carrying the cue', async () => {
    const r = renderAtSize(
      <Box height={10} flexDirection="column">
        <ScrollRegion>
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {lines(30)}
          </Box>
        </ScrollRegion>
      </Box>,
      { columns: 40, rows: 10 }
    );
    await tick(60);
    const frame = r.lastFrame() ?? '';
    const cue = frame.split('\n').find((l) => l.includes('▾')) ?? '';
    expect(cue.startsWith('╰')).toBe(true);
    expect(cue.trimEnd().endsWith('╯')).toBe(true);
    expect(cue).toMatch(/▾ \d+ more/);
    expect([...cue.trimEnd()]).toHaveLength(40);
    r.unmount();
  });

  it('keeps the plain cue when the cut falls between content, not inside a box', async () => {
    const r = renderAtSize(
      <Box height={10} flexDirection="column">
        <ScrollRegion>{lines(30)}</ScrollRegion>
      </Box>,
      { columns: 40, rows: 10 }
    );
    await tick(60);
    const cue = (r.lastFrame() ?? '').split('\n').find((l) => l.includes('▾')) ?? '';
    expect(cue.trim()).toMatch(/^▾ \d+ more$/);
    r.unmount();
  });
});
