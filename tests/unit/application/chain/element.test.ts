import { describe, expect, it } from 'vitest';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { checkAborted } from '@src/application/chain/element.ts';
import { abortedEntry, skippedEntry } from '@src/application/chain/trace.ts';

describe('abortedEntry', () => {
  it('builds an aborted entry with default reason', () => {
    const entry = abortedEntry('step-x');
    expect(entry.elementName).toBe('step-x');
    expect(entry.status).toBe('aborted');
    expect(entry.durationMs).toBe(0);
    expect(entry.error).toBeInstanceOf(AbortError);
    expect((entry.error as AbortError).elementName).toBe('step-x');
  });

  it('uses the supplied reason on the AbortError', () => {
    const entry = abortedEntry('step-x', 'user pressed kill');
    expect((entry.error as AbortError).reason).toBe('user pressed kill');
    expect(entry.error?.message).toBe('user pressed kill');
  });
});

describe('skippedEntry', () => {
  it('builds a skipped entry with no error attached', () => {
    const entry = skippedEntry('step-x');
    expect(entry).toEqual({ elementName: 'step-x', status: 'skipped', durationMs: 0 });
    expect(entry.error).toBeUndefined();
  });
});

describe('checkAborted', () => {
  it('returns undefined when no signal supplied', () => {
    expect(checkAborted('step-x', undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when signal not aborted', () => {
    const ac = new AbortController();
    expect(checkAborted('step-x', ac.signal, undefined)).toBeUndefined();
  });

  it('returns a failure result and emits the aborted entry when signal is tripped', () => {
    const ac = new AbortController();
    ac.abort();
    const emitted: unknown[] = [];
    const onTrace = (entry: unknown): void => {
      emitted.push(entry);
    };
    const result = checkAborted('step-x', ac.signal, onTrace);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error.error).toBeInstanceOf(AbortError);
      expect(result!.error.trace).toHaveLength(1);
      expect(result!.error.trace[0]?.status).toBe('aborted');
    }
    expect(emitted).toHaveLength(1);
  });
});
