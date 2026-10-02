import { describe, expect, it } from 'vitest';
import { fitHints } from '@src/application/ui/tui/components/keyboard-hints.tsx';

const hint = (keys: string, label: string): { keys: string; label: string } => ({ keys, label });
const strip = (hints: ReadonlyArray<{ keys: string; label: string }>): string =>
  hints.map((h) => `${h.keys} ${h.label}`).join(' · ');

describe('fitHints', () => {
  const hints = [
    hint('↑/↓', 'move'),
    hint('esc', 'back'),
    hint('h', 'home'),
    hint('n', 'new flow'),
    hint('P', 'pick project'),
    hint('?', 'help'),
    hint('q/ctrl+c', 'quit'),
  ];
  const pinned = new Set(['?', 'q/ctrl+c']);

  it('returns the strip untouched when it fits', () => {
    expect(fitHints(hints, 200, 1, pinned)).toEqual(hints);
  });

  it('drops whole hints right to left, keeping local actions and the pinned help/quit', () => {
    const fitted = fitHints(hints, 55, 1, pinned);
    expect(fitted.map((h) => h.keys)).toEqual(['↑/↓', 'esc', 'h', '?', 'q/ctrl+c']);
    expect(strip(fitted).length).toBeLessThanOrEqual(55);
  });

  it('never drops a view action, even when the strip stays too wide', () => {
    const fitted = fitHints(hints, 5, 2, pinned);
    expect(fitted.map((h) => h.keys)).toEqual(['↑/↓', 'esc', '?', 'q/ctrl+c']);
  });
});
