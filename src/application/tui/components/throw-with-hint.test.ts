import { describe, expect, it } from 'vitest';

import { throwWithHint } from './throw-with-hint.ts';

describe('throwWithHint', () => {
  it('throws an Error carrying the original message', () => {
    expect(() => throwWithHint({ message: 'boom' })).toThrow('boom');
  });

  it('attaches the hint to the thrown Error when present', () => {
    try {
      throwWithHint({ message: 'sprint not found', hint: 'Run `ralphctl sprint list`.' });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as { hint?: string }).hint).toBe('Run `ralphctl sprint list`.');
      return;
    }
    throw new Error('expected throwWithHint to throw');
  });

  it('omits the hint property when hint is undefined', () => {
    try {
      throwWithHint({ message: 'oops' });
    } catch (e) {
      expect((e as { hint?: string }).hint).toBeUndefined();
      return;
    }
    throw new Error('expected throwWithHint to throw');
  });

  it('omits the hint property when hint is an empty string', () => {
    try {
      throwWithHint({ message: 'oops', hint: '' });
    } catch (e) {
      expect((e as { hint?: string }).hint).toBeUndefined();
      return;
    }
    throw new Error('expected throwWithHint to throw');
  });
});
