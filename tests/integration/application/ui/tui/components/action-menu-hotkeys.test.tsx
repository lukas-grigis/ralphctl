/**
 * ActionMenu — hotkey vs windowed-list nav-alias guard.
 *
 * `useListWindow` (mounted alongside ActionMenu's own hotkey `useInput`) binds `j`/`k` as the
 * vim-alias for cursor move (DESIGN-SYSTEM §6.4). If a `MenuItem` ever declared `hotkey: 'j'` (or
 * `'k'`), Ink would fire BOTH handlers for the same keystroke: the cursor moves AND the
 * hotkeyed item's `onSelect` fires. `matchHotkey` must refuse to match these two reserved chars
 * regardless of what a `MenuItem` declares, so the keystroke behaves as pure navigation.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('ActionMenu — reserved nav-alias hotkey guard', () => {
  it('a MenuItem hotkeyed to "j" never fires onSelect from the "j" keystroke — only the cursor moves', async () => {
    const alphaSelect = vi.fn();
    const betaSelect = vi.fn();
    const gammaSelect = vi.fn();
    const items: readonly MenuItem[] = [
      { id: 'alpha', label: 'Alpha', onSelect: alphaSelect },
      // Pathological: a future menu item hotkeyed to the reserved "down" nav alias.
      { id: 'beta', label: 'Beta', onSelect: betaSelect, hotkey: 'j' },
      { id: 'gamma', label: 'Gamma', onSelect: gammaSelect },
    ];
    const r = render(<ActionMenu items={items} active />);
    await tick(30);

    r.stdin.write('j');
    await tick(30);

    // Cursor moved down onto Beta (same as pressing the down-arrow / DOWN key would).
    expect(r.lastFrame() ?? '').toMatch(/▸\s*Beta/);
    // Neither item's onSelect fired — "j" is nav-only, never a hotkey trigger.
    expect(alphaSelect).not.toHaveBeenCalled();
    expect(betaSelect).not.toHaveBeenCalled();
    expect(gammaSelect).not.toHaveBeenCalled();

    r.unmount();
  });

  it('"j" and DOWN move the cursor identically when no item claims it as a hotkey', async () => {
    const items: readonly MenuItem[] = [
      { id: 'alpha', label: 'Alpha', onSelect: (): void => undefined },
      { id: 'beta', label: 'Beta', onSelect: (): void => undefined },
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

  it('a non-reserved hotkey still fires onSelect directly, without moving the cursor first', async () => {
    const gammaSelect = vi.fn();
    const items: readonly MenuItem[] = [
      { id: 'alpha', label: 'Alpha', onSelect: (): void => undefined },
      { id: 'beta', label: 'Beta', onSelect: (): void => undefined },
      { id: 'gamma', label: 'Gamma', onSelect: gammaSelect, hotkey: 'z' },
    ];
    const r = render(<ActionMenu items={items} active />);
    await tick(30);

    r.stdin.write('z');
    await tick(30);

    expect(gammaSelect).toHaveBeenCalledTimes(1);

    r.unmount();
  });
});
