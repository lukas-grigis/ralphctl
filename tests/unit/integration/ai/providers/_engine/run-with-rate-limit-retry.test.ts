import { describe, expect, it } from 'vitest';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { runWithRateLimitRetry } from '@src/integration/ai/providers/_engine/run-with-rate-limit-retry.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';

const session = (): AiSession => ({
  prompt: 'prompt-body',
  cwd: absolutePath('/tmp/retry-loop-test-repo'),
  model: 'test-model',
  permissions: FULL_AUTO,
  signalsFile: absolutePath('/tmp/retry-loop-test-repo/signals.json'),
});

const successOutput = (): ProviderOutput => ({
  signalsFile: absolutePath('/tmp/retry-loop-test-repo/signals.json'),
  exitCode: 0,
});

/** One rate-limited attempt, then success — forces exactly one backoff wait. */
const attemptOnceThenSucceed = (): ((s: AiSession) => Promise<AttemptOutcome>) => {
  let calls = 0;
  return (): Promise<AttemptOutcome> => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? { kind: 'rate-limit', error: new RateLimitError({ subCode: 'spawn-stderr', message: 'rate limit' }) }
        : { kind: 'success', output: successOutput() }
    );
  };
};

describe('runWithRateLimitRetry backoff jitter', () => {
  it('spreads the backoff wait by +20% when the injected random source returns 1', async () => {
    const cap = createCapturingBus();
    const out = await runWithRateLimitRetry({
      session: session(),
      rateLimitRetries: 1,
      backoffSchedule: [10],
      eventBus: cap.bus,
      providerSlug: 'claude',
      providerName: 'claude-test',
      random: () => 1,
      attempt: attemptOnceThenSucceed(),
    });
    expect(out.ok).toBe(true);
    // applyJitter(10, () => 1) = round(10 - 2 + 1 * 4) = 12 — an un-jittered loop logs 10.
    const wait = cap.logs.find((l) => /waiting \d+ms before retry/.test(l.message));
    expect(wait?.message).toContain('waiting 12ms');
  });

  it('spreads the backoff wait by -20% when the injected random source returns 0', async () => {
    const cap = createCapturingBus();
    const out = await runWithRateLimitRetry({
      session: session(),
      rateLimitRetries: 1,
      backoffSchedule: [10],
      eventBus: cap.bus,
      providerSlug: 'claude',
      providerName: 'claude-test',
      random: () => 0,
      attempt: attemptOnceThenSucceed(),
    });
    expect(out.ok).toBe(true);
    expect(cap.logs.find((l) => /waiting \d+ms before retry/.test(l.message))?.message).toContain('waiting 8ms');
  });

  it('keeps the zero-delay fast path un-jittered so test schedules of [0] never sleep', async () => {
    const cap = createCapturingBus();
    const out = await runWithRateLimitRetry({
      session: session(),
      rateLimitRetries: 1,
      backoffSchedule: [0],
      eventBus: cap.bus,
      providerSlug: 'claude',
      providerName: 'claude-test',
      random: () => 1,
      attempt: attemptOnceThenSucceed(),
    });
    expect(out.ok).toBe(true);
    expect(cap.logs.some((l) => /waiting \d+ms before retry/.test(l.message))).toBe(false);
  });
});
