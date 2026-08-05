import { describe, expect, it } from 'vitest';
import type { IterationConfig } from '@src/application/chain/run/iteration-config.ts';
import { buildAttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';

/**
 * `buildAttemptReadConfig` is the ONE place that projects a live `IterationConfig` down to the
 * `AttemptReadConfig` shape the attempt loop / escalation policy read — shared by the serial
 * launcher (`flow.ts`) and the parallel launcher (`ui/shared/launch/implement.ts`) specifically so
 * a field neither hand-rolled `readConfig` literal can silently omit. Regression coverage for the
 * exact drift this replaced: the parallel launcher's own `readConfig` once omitted
 * `bestOfNCandidates`, so the opt-in best-of-N remedy never fired for a parallel-launched sprint
 * even when the operator opted in — see `ui/shared/launch/implement.ts`'s `buildParallelElement`.
 */

const harness: IterationConfig = {
  maxTurns: 5,
  maxAttempts: 3,
  rateLimitRetries: 2,
  plateauThreshold: 3,
  correctiveRetries: 2,
  escalateOnPlateau: true,
  escalationMap: { 'claude-haiku-4-5': 'claude-sonnet-4-6' },
  skipPreVerifyOnFreshSetup: false,
};

describe('buildAttemptReadConfig', () => {
  it('projects the five AttemptReadConfig fields off a live IterationConfig', async () => {
    const readConfig = buildAttemptReadConfig({ ...harness, bestOfNCandidates: 3 });
    await expect(readConfig()).resolves.toEqual({
      maxTurns: 5,
      escalateOnPlateau: true,
      escalationMap: { 'claude-haiku-4-5': 'claude-sonnet-4-6' },
      maxAttempts: 3,
      bestOfNCandidates: 3,
    });
  });

  it('omits bestOfNCandidates from the resolved shape when the source field is undefined', async () => {
    const readConfig = buildAttemptReadConfig(harness);
    const resolved = await readConfig();
    expect('bestOfNCandidates' in resolved).toBe(false);
  });

  it('carries an explicit 0 through unchanged (0 is a meaningful "disabled", distinct from absent)', async () => {
    const readConfig = buildAttemptReadConfig({ ...harness, bestOfNCandidates: 0 });
    await expect(readConfig()).resolves.toMatchObject({ bestOfNCandidates: 0 });
  });

  it('re-reads the SAME closure-captured snapshot on every call (byte-identical, not re-derived)', async () => {
    const readConfig = buildAttemptReadConfig({ ...harness, bestOfNCandidates: 2 });
    const first = await readConfig();
    const second = await readConfig();
    expect(first).toEqual(second);
  });
});
