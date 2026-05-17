import { describe, expect, it } from 'vitest';
import {
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
});
