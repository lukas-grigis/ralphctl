import { describe, expect, it } from 'vitest';
import { fitHints, joinedWidth, MORE_HINT, type FitHint } from '@src/application/ui/tui/components/hint-budget.ts';

const locals: FitHint[] = [
  { keys: '↑/↓', label: 'move' },
  { keys: '↵', label: 'open' },
  { keys: 'b', label: 'browse' },
  { keys: 'u', label: 'unblock (3)' },
  { keys: 'B', label: 'next blocked' },
  { keys: 'v', label: 'evaluation' },
];
const globals: FitHint[] = [
  { keys: 'esc', label: 'back' },
  { keys: '?', label: 'help' },
  { keys: 'h', label: 'home' },
  { keys: 'n', label: 'new flow' },
  { keys: 'x', label: 'sessions' },
  { keys: 's', label: 'settings' },
  { keys: 'P', label: 'pick project' },
  { keys: 'q/ctrl+c', label: 'quit' },
];
const input = [...locals, ...globals];

describe('fitHints', () => {
  it.each([60, 80, 100, 120])('fits the budget at %i columns', (width) => {
    const { visible, dropped } = fitHints(input, width);
    expect(joinedWidth(visible)).toBeLessThanOrEqual(width);
    const cells = dropped.length > 0 ? visible.slice(0, -1) : visible;
    for (const c of cells) expect(input).toContain(c);
    // Priority: locals come first, in declared order.
    const localsShown = cells.filter((c) => locals.includes(c));
    expect(cells.slice(0, localsShown.length)).toEqual(localsShown);
    expect(localsShown).toEqual(locals.slice(0, localsShown.length));
    if (dropped.length > 0) expect(visible[visible.length - 1]).toBe(MORE_HINT);
    else expect(visible).not.toContain(MORE_HINT);
    expect(visible.length - (dropped.length > 0 ? 1 : 0) + dropped.length).toBe(input.length);
  });

  it('drops a suffix only and reports `… ? more` last', () => {
    const { visible, dropped } = fitHints(input, 60);
    expect(dropped.length).toBeGreaterThan(0);
    expect(`${MORE_HINT.keys} ${MORE_HINT.label}`).toBe('… ? more');
    expect(dropped).toEqual(input.slice(input.length - dropped.length));
    expect(visible[visible.length - 1]).toBe(MORE_HINT);
  });

  it('returns everything untouched when it all fits', () => {
    const r = fitHints(globals, 500);
    expect(r.visible).toEqual(globals);
    expect(r.dropped).toEqual([]);
  });
});
