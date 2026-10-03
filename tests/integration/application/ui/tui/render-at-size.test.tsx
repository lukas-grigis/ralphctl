import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const Wide = (): React.JSX.Element => (
  <Box width={160}>
    <Text>{'x'.repeat(160)}</Text>
  </Box>
);

const Size = (): React.JSX.Element => {
  const { columns, rows } = useTerminalSize();
  return <Text>{`size:${String(columns)}x${String(rows)}`}</Text>;
};

describe('renderAtSize', () => {
  it('renders a 160-column line at 160 columns', () => {
    const r = renderAtSize(<Wide />, { columns: 160, rows: 45 });
    const line = (r.lastFrame() ?? '').split('\n')[0] ?? '';
    expect(line).toHaveLength(160);
    r.unmount();
  });

  it('re-renders with the new size after resize()', async () => {
    const r = renderAtSize(<Size />, { columns: 120, rows: 40 });
    expect(r.lastFrame()).toContain('size:120x40');
    r.resize(80, 24);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('size:80x24'), { label: 'resized frame' });
    r.unmount();
  });
});
