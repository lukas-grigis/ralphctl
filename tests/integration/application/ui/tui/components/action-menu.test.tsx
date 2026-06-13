/**
 * ActionMenu — cost hint rendering.
 *
 * Verifies that:
 *   - the focused row shows its `costHint` (if present) beneath the description.
 *   - unfocused rows do NOT show their cost hint.
 *   - rows without a `costHint` show nothing extra.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const noop = (): void => undefined;

const makeItems = (): readonly MenuItem[] => [
  {
    id: 'ideate',
    label: 'Ideate',
    description: 'Quick idea to tasks in one session.',
    costHint: 'single AI session — fast, low token spend',
    onSelect: noop,
  },
  {
    id: 'implement',
    label: 'Implement',
    description: 'Generator–evaluator loop on every task.',
    costHint: 'generator–evaluator loop per task — higher token spend, independently verified output',
    onSelect: noop,
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Generate tasks from approved tickets.',
    // No costHint on this item.
    onSelect: noop,
  },
];

describe('ActionMenu — cost hints', () => {
  it('shows the cost hint of the initially-focused row and not for unfocused rows', async () => {
    const items = makeItems();
    const r = render(<ActionMenu items={items} active />);
    await tick(30);

    const frame = r.lastFrame() ?? '';
    // Cursor starts at index 0 → Ideate is focused.
    expect(frame).toContain('Ideate');
    expect(frame).toContain('single AI session');

    // Other rows' hints must not appear.
    expect(frame).not.toContain('generator–evaluator loop per task');

    r.unmount();
  });

  it('shows the cost hint for the newly-focused row after moving down', async () => {
    const items = makeItems();
    const r = render(<ActionMenu items={items} active />);
    await tick(30);

    // Move cursor to Implement (row index 1).
    r.stdin.write(DOWN);
    await tick(30);

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Implement');
    expect(frame).toContain('generator–evaluator loop per task');

    // Ideate's hint is no longer shown (it's no longer focused).
    expect(frame).not.toContain('single AI session');

    r.unmount();
  });

  it('shows no cost hint for a row that has none', async () => {
    const items = makeItems();
    const r = render(<ActionMenu items={items} active />);
    await tick(30);

    // Move cursor to Plan (row index 2).
    r.stdin.write(DOWN);
    await tick(20);
    r.stdin.write(DOWN);
    await tick(30);

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Plan');
    // Neither of the other rows' hints should appear.
    expect(frame).not.toContain('single AI session');
    expect(frame).not.toContain('generator–evaluator loop per task');

    r.unmount();
  });
});
