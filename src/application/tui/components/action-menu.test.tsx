/**
 * ActionMenu component tests.
 *
 * Covers:
 * - Separator skipping during navigation
 * - Disabled item skipping
 * - Enter fires onSelect with the typed MenuAction
 * - Esc fires onCancel
 * - Cursor navigation wraps correctly
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ActionMenu } from './action-menu.tsx';
import type { SubMenu } from '../views/menu-builder.ts';
import type { MenuAction } from '../views/menu-action.ts';
import { actionKey } from '../views/menu-action.ts';

const FIRST: MenuAction = { kind: 'route', viewId: 'sprint-list' };
const SECOND: MenuAction = { kind: 'route', viewId: 'ticket-list' };
const THIRD: MenuAction = { kind: 'route', viewId: 'task-list' };
const DISABLED_ACTION: MenuAction = { kind: 'route', viewId: 'project-list' };

function makeItems(): SubMenu['items'] {
  return [
    { separator: 'SECTION' },
    { name: 'First', action: FIRST, description: 'First item' },
    { name: 'Second', action: SECOND, description: 'Second item' },
    { separator: '' },
    { name: 'Disabled', action: DISABLED_ACTION, disabled: 'not available' },
    { name: 'Third', action: THIRD },
  ];
}

describe('ActionMenu', () => {
  it('renders without crashing', () => {
    const { lastFrame } = render(<ActionMenu items={makeItems()} onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(lastFrame()).toBeTruthy();
  });

  it('renders item names', () => {
    const { lastFrame } = render(<ActionMenu items={makeItems()} onSelect={vi.fn()} onCancel={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('First');
    expect(frame).toContain('Second');
    expect(frame).toContain('Third');
  });

  it('renders disabled reason for disabled items', () => {
    const { lastFrame } = render(<ActionMenu items={makeItems()} onSelect={vi.fn()} onCancel={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('not available');
  });

  it('fires onSelect with typed action on Enter', () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ActionMenu items={makeItems()} onSelect={onSelect} onCancel={vi.fn()} />);
    stdin.write('\r');
    // First selectable item (index 1, since 0 is separator)
    expect(onSelect).toHaveBeenCalledWith(FIRST);
  });

  it('fires onCancel on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ActionMenu items={makeItems()} onSelect={vi.fn()} onCancel={onCancel} />);
    stdin.write('\x1B');
    await new Promise((r) => setTimeout(r, 20));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('navigates down skipping separators and disabled items', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ActionMenu items={makeItems()} onSelect={onSelect} onCancel={vi.fn()} />);
    // Start at First (idx 1), down goes to Second (idx 2), down goes to Third (idx 5)
    // skipping the separator (idx 3) and disabled (idx 4)
    stdin.write('\x1B[B'); // down → Second
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\x1B[B'); // down → Third (skips sep+disabled)
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledWith(THIRD);
  });

  it('navigates up skipping separators and disabled items', () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ActionMenu items={makeItems()} onSelect={onSelect} onCancel={vi.fn()} />);
    // Start at First (idx 1)
    stdin.write('\x1B[A'); // up — should stay at First (no selectable above)
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith(FIRST);
  });

  it('respects initialActionKey prop — cursor starts on matching item', () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ActionMenu items={makeItems()} onSelect={onSelect} onCancel={vi.fn()} initialActionKey={actionKey(THIRD)} />
    );
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith(THIRD);
  });

  it('does not call onSelect on Enter when all items are disabled', () => {
    const onSelect = vi.fn();
    const items: SubMenu['items'] = [
      { name: 'A', action: { kind: 'route', viewId: 'sprint-list' }, disabled: 'nope' },
      { name: 'B', action: { kind: 'route', viewId: 'task-list' }, disabled: true },
    ];
    const { stdin } = render(<ActionMenu items={items} onSelect={onSelect} onCancel={vi.fn()} />);
    stdin.write('\r');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('vim keybindings j/k navigate down/up', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ActionMenu items={makeItems()} onSelect={onSelect} onCancel={vi.fn()} />);
    stdin.write('j'); // down → Second
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledWith(SECOND);
  });
});
