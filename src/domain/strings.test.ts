import { describe, expect, it } from 'vitest';
import { truncate } from './strings.ts';

describe('truncate', () => {
  it('returns the string unchanged when shorter than max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly max length', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('clips with ellipsis when longer than max', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello world', 8).length).toBe(8);
  });

  it('handles max=1 and max=0 without throwing', () => {
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('hello', 0)).toBe('');
  });
});
