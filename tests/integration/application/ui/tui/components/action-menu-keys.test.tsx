/** ActionMenu keys: `j` aliases ↓, space selects the focused row, and no letter selects a row on its own. */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const noop = (): void => undefined;

describe('ActionMenu keys', () => {
  it('"j" and DOWN move the cursor identically', async () => {
    const items: readonly MenuItem[] = [
      { id: 'alpha', label: 'Alpha', onSelect: noop },
      { id: 'beta', label: 'Beta', onSelect: noop },
    ];
    const r = render(<ActionMenu items={items} active />);
    await tick(30);
    r.stdin.write(DOWN);
    await tick(30);
    const viaArrow = r.lastFrame() ?? '';
    r.unmount();

    const r2 = render(<ActionMenu items={items} active />);
    await tick(30);
    r2.stdin.write('j');
    await tick(30);
    const viaJ = r2.lastFrame() ?? '';
    r2.unmount();

    expect(viaJ).toBe(viaArrow);
  });

  it('space selects the focused row; other letters select nothing', async () => {
    const beta = vi.fn();
    const items: readonly MenuItem[] = [
      { id: 'alpha', label: 'Alpha', onSelect: noop },
      { id: 'beta', label: 'Beta', onSelect: beta },
    ];
    const r = render(<ActionMenu items={items} active />);
    await tick(30);
    r.stdin.write('z');
    await tick(30);
    expect(beta).not.toHaveBeenCalled();
    r.stdin.write(DOWN);
    await tick(30);
    r.stdin.write(' ');
    await tick(30);
    expect(beta).toHaveBeenCalledTimes(1);
    r.unmount();
  });
});
