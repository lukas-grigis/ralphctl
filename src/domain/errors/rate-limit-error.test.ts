import { describe, expect, it } from 'vitest';

import type { DomainError } from './domain-error.ts';
import { RateLimitError } from './rate-limit-error.ts';

describe('RateLimitError', () => {
  it('has the kebab-case discriminator code', () => {
    const err = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err.code).toBe('rate-limit');
  });

  it('preserves the subCode discriminator', () => {
    const sub = ['spawn-stderr', 'spawn-exit'] as const;
    for (const subCode of sub) {
      const err = new RateLimitError({ subCode });
      expect(err.subCode).toBe(subCode);
    }
  });

  it('uses a sensible default message for spawn-stderr', () => {
    const err = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err.message).toContain('rate-limit pattern');
  });

  it('uses a sensible default message for spawn-exit', () => {
    const err = new RateLimitError({ subCode: 'spawn-exit' });
    expect(err.message).toContain('exited');
  });

  it('embeds retryAfterMs in the default message when supplied', () => {
    const err = new RateLimitError({ subCode: 'spawn-exit', retryAfterMs: 60000 });
    expect(err.message).toContain('60000');
  });

  it('honours an explicit message override', () => {
    const err = new RateLimitError({
      subCode: 'spawn-stderr',
      message: 'custom upstream said no',
    });
    expect(err.message).toBe('custom upstream said no');
  });

  it('copies through retryAfterMs', () => {
    const err = new RateLimitError({ subCode: 'spawn-exit', retryAfterMs: 30_000 });
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('leaves retryAfterMs undefined when omitted', () => {
    const err = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('copies through sessionId', () => {
    const err = new RateLimitError({ subCode: 'spawn-exit', sessionId: 'sess-abc' });
    expect(err.sessionId).toBe('sess-abc');
  });

  it('leaves sessionId undefined when omitted', () => {
    const err = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err.sessionId).toBeUndefined();
  });

  it('preserves cause', () => {
    const cause = new Error('upstream 429');
    const err = new RateLimitError({ subCode: 'spawn-exit', cause });
    expect(err.cause).toBe(cause);
  });

  it('is an instance of Error and structurally a KernelError', () => {
    const err = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitError');
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  });

  it('satisfies the DomainError union (compile-time)', () => {
    const err: DomainError = new RateLimitError({ subCode: 'spawn-stderr' });
    expect(err.code).toBe('rate-limit');
  });
});
