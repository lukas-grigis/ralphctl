import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from '@src/application/ui/tui/runtime/expand-home.ts';

describe('expandHome', () => {
  it('expands a bare tilde and a leading tilde segment', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/code/app')).toBe(join(homedir(), 'code/app'));
  });

  it('leaves other paths untouched', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('~user/app')).toBe('~user/app');
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
  });
});
