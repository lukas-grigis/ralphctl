import { describe, expect, it } from 'vitest';
import { isColorDisabled } from '@src/application/ui/tui/runtime/use-no-color.ts';
import { paintMultiline, palettes } from '@src/application/ui/tui/theme/gradient.ts';

describe('isColorDisabled', () => {
  it('is true for a non-empty NO_COLOR or TERM=dumb', () => {
    expect(isColorDisabled({ NO_COLOR: '1' })).toBe(true);
    expect(isColorDisabled({ TERM: 'dumb' })).toBe(true);
  });

  it('is false for an empty NO_COLOR or an ordinary terminal', () => {
    expect(isColorDisabled({ NO_COLOR: '' })).toBe(false);
    expect(isColorDisabled({ TERM: 'xterm-256color' })).toBe(false);
    expect(isColorDisabled({})).toBe(false);
  });
});

describe('paintMultiline', () => {
  const art = 'ab\ncd';

  it('paints truecolor escapes by default', () => {
    const prev = process.env['NO_COLOR'];
    delete process.env['NO_COLOR'];
    try {
      expect(paintMultiline(art, palettes.donut)).toContain('\x1b[38;2;');
    } finally {
      if (prev !== undefined) process.env['NO_COLOR'] = prev;
    }
  });

  it('returns the art uncoloured under NO_COLOR', () => {
    const prev = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      expect(paintMultiline(art, palettes.donut)).toBe(art);
    } finally {
      if (prev === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = prev;
    }
  });
});
