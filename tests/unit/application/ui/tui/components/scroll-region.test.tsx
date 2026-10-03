import React from 'react';
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

describe('ScrollRegion keys', () => {
  it('pages down on PgDn', async () => {
    const r = renderAtSize(<Lines />, { columns: 80, rows: 10 });
    await tick(50);
    expect(r.lastFrame()).toContain('line 0');
    r.stdin.write(PAGE_DOWN);
    await tick(50);
    expect(r.lastFrame()).not.toContain('line 0');
    r.unmount();
  });

  it('leaves g / G alone — g is the global progress overlay', async () => {
    const r = renderAtSize(<Lines />, { columns: 80, rows: 10 });
    await tick(50);
    r.stdin.write('G');
    await tick(50);
    expect(r.lastFrame()).toContain('line 0');
    r.unmount();
  });
});
