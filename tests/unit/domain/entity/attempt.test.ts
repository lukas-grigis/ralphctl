import { describe, expect, it } from 'vitest';
import {
  type AbortCause,
  completeAttempt,
  isVerifiedAttempt,
  recordAttemptVerification,
  startAttempt,
} from '@src/domain/entity/attempt.ts';
import { FIXED_LATER, FIXED_NOW } from '@tests/fixtures/domain.ts';

describe('startAttempt', () => {
  it('produces a running attempt', () => {
    const r = startAttempt({ n: 1, startedAt: FIXED_NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('running');
    expect(r.value.finishedAt).toBeNull();
  });

  it('rejects non-positive n', () => {
    expect(startAttempt({ n: 0, startedAt: FIXED_NOW }).ok).toBe(false);
    expect(startAttempt({ n: -1, startedAt: FIXED_NOW }).ok).toBe(false);
    expect(startAttempt({ n: 1.5, startedAt: FIXED_NOW }).ok).toBe(false);
  });
});

describe('completeAttempt', () => {
  const seed = () => {
    const r = startAttempt({ n: 1, startedAt: FIXED_NOW });
    if (!r.ok) throw new Error('seed');
    return r.value;
  };

  it('transitions to verified when verification is set', () => {
    const att = recordAttemptVerification(seed());
    const r = completeAttempt(att, 'verified', FIXED_LATER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('verified');
    expect(isVerifiedAttempt(r.value)).toBe(true);
  });

  it('rejects verified completion without verification', () => {
    const r = completeAttempt(seed(), 'verified', FIXED_LATER);
    expect(r.ok).toBe(false);
  });

  it.each(['failed', 'malformed', 'aborted'] as const)('transitions to %s without verification', (status) => {
    const r = completeAttempt(seed(), status, FIXED_LATER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe(status);
    expect(r.value.finishedAt).toBe(FIXED_LATER);
  });

  it.each(['user-cancel', 'sigterm', 'watchdog-killed', 'rate-limit-exhausted', 'process-crash', 'unknown'] as const)(
    'stamps abortCause=%s on aborted attempt',
    (cause: AbortCause) => {
      const r = completeAttempt(seed(), 'aborted', FIXED_LATER, { abortCause: cause });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Discriminated narrowing — the field is only meaningful on aborted attempts.
      expect(r.value.status).toBe('aborted');
      if (r.value.status !== 'aborted') return;
      expect(r.value.abortCause).toBe(cause);
    }
  );

  it('stamps signalOrExitCode (string) on aborted attempt when supplied', () => {
    const r = completeAttempt(seed(), 'aborted', FIXED_LATER, {
      abortCause: 'sigterm',
      signalOrExitCode: 'SIGTERM',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.signalOrExitCode).toBe('SIGTERM');
  });

  it('stamps signalOrExitCode (number) on aborted attempt when supplied', () => {
    const r = completeAttempt(seed(), 'aborted', FIXED_LATER, {
      abortCause: 'user-cancel',
      signalOrExitCode: 130,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.signalOrExitCode).toBe(130);
  });

  it('omits abortCause / signalOrExitCode when no abortMeta supplied (legacy data path)', () => {
    const r = completeAttempt(seed(), 'aborted', FIXED_LATER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.abortCause).toBeUndefined();
    expect(r.value.signalOrExitCode).toBeUndefined();
  });

  it('ignores abortMeta on non-aborted terminal statuses', () => {
    // Sanity guard: even if a caller passes abortMeta on `failed` or `malformed`, the
    // domain treats it as a no-op — abort attribution lives on aborted attempts only.
    const failed = completeAttempt(seed(), 'failed', FIXED_LATER, { abortCause: 'unknown' });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.abortCause).toBeUndefined();
  });
});

describe('startAttempt — recovering context', () => {
  it('stamps recovering on the new running attempt when supplied', () => {
    const r = startAttempt({
      n: 4,
      startedAt: FIXED_NOW,
      recovering: { fromAttemptN: 3, cause: 'process-crash', abortedAt: FIXED_LATER },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recovering).toEqual({
      fromAttemptN: 3,
      cause: 'process-crash',
      abortedAt: FIXED_LATER,
    });
  });

  it('omits recovering on a clean start (no resume)', () => {
    const r = startAttempt({ n: 1, startedAt: FIXED_NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recovering).toBeUndefined();
  });
});
