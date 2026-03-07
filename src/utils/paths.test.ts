import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { expandTilde } from './paths.ts';

describe('expandTilde', () => {
  it('expands ~/foo to homedir()/foo', () => {
    expect(expandTilde('~/foo')).toBe(`${homedir()}/foo`);
  });

  it('expands bare ~ to homedir()', () => {
    expect(expandTilde('~')).toBe(homedir());
  });

  it('returns already-absolute path unchanged', () => {
    expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('returns relative path without tilde unchanged', () => {
    expect(expandTilde('foo/bar')).toBe('foo/bar');
  });
});
