import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { PAGE_DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const Lines = (): React.JSX.Element => (
  <Box flexDirection="column" height={10}>
    <ScrollRegion>
      {Array.from({ length: 40 }, (_, i) => (
        <Text key={i}>line {String(i)}</Text>
      ))}
    </ScrollRegion>
  </Box>
);

describe('ScrollRegion overflow cues', () => {
  it('shows only ▾ at the top, then both cues after PgDn', async () => {
    const r = renderAtSize(<Lines />, { columns: 80, rows: 10 });
    await tick(50);
    const top = r.lastFrame() ?? '';
    expect(top).toContain('▾');
    expect(top).not.toContain('▴');
    r.stdin.write(PAGE_DOWN);
    await tick(50);
    const mid = r.lastFrame() ?? '';
    expect(mid).toContain('▴');
    expect(mid).toContain('▾');
    r.unmount();
  });

  it('renders no cue when the content fits', async () => {
    const r = renderAtSize(
      <Box height={10} flexDirection="column">
        <ScrollRegion>
          <Text>short</Text>
        </ScrollRegion>
      </Box>,
      { columns: 80, rows: 10 }
    );
    await tick(50);
    expect(r.lastFrame() ?? '').not.toMatch(/[▴▾]/);
    r.unmount();
  });

  it('does not bind g / G (g is the global progress overlay)', () => {
    const src = readFileSync('src/application/ui/tui/components/scroll-region.tsx', 'utf8');
    expect(src).not.toMatch(/input === 'g'/);
    expect(src).not.toMatch(/input === 'G'/);
  });
});
