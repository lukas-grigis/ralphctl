import { Result } from '@src/domain/result.ts';
import type { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { type AttemptOutcome, abortedByCaller } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { ProviderSlug } from '@src/integration/ai/providers/_engine/classify-spawn-exit.ts';
import {
  applyJitter,
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';

/**
 * The one rate-limit retry loop every headless adapter runs through. The adapter's `attempt` builds
 * argv from the session it is GIVEN, so when a rate-limit outcome carries a captured session id the
 * loop retries with `{ ...session, resume: id }` and the CLI resumes instead of cold-starting.
 *
 * Stale-resume cold fallback: an `error` outcome matching `resumeStaleRe` on a resumed session
 * drops `resume` (and swaps in `coldPrompt`) for ONE cold respawn of the SAME attempt index, so it
 * never consumes a rate-limit slot. An aborted run is exempt — a cancel must not spawn fresh work.
 */
export interface RunWithRateLimitRetryOptions {
  /** The first attempt runs with this; retries rebuild it. */
  readonly session: AiSession;
  /** Retries on `RateLimitError` before surfacing the failure. */
  readonly rateLimitRetries: number;
  readonly backoffSchedule?: readonly number[];
  /** `[0, 1)` source for {@link applyJitter}; injectable so tests pin the jittered delay. */
  readonly random?: () => number;
  readonly eventBus: EventBus;
  /** Keys the banner ids, so concurrent adapters don't collide. */
  readonly providerSlug: ProviderSlug;
  readonly providerName: string;
  /** The CLI's "that resume id no longer exists" wording. */
  readonly resumeStaleRe: RegExp;
  readonly attempt: (session: AiSession) => Promise<AttemptOutcome>;
}

const withResume = (session: AiSession, resumeId: string): AiSession => ({
  ...session,
  resume: resumeId as SessionId,
});

/** The slim continuation prompt presumes a conversation the cold spawn does not have. */
const withoutResume = (session: AiSession): AiSession => {
  const { resume: _resume, coldPrompt, ...rest } = session;
  void _resume;
  return { ...rest, ...(coldPrompt !== undefined ? { prompt: coldPrompt } : {}) };
};

type RateLimitOutcomeResult =
  { readonly type: 'aborted'; readonly error: AbortError } | { readonly type: 'continue'; readonly session: AiSession };

interface RateLimitStep {
  readonly session: AiSession;
  readonly attemptIdx: number;
  readonly maxAttempts: number;
  readonly error: RateLimitError;
}

/**
 * Warn, carry the captured session id forward, and — unless this was the last attempt — wait out
 * the jittered backoff behind a show/clear banner pair. A cancel cuts the wait short.
 */
const handleRateLimitOutcome = async (
  { eventBus, providerSlug, providerName, backoffSchedule, random }: RunWithRateLimitRetryOptions,
  { session, attemptIdx, maxAttempts, error }: RateLimitStep
): Promise<RateLimitOutcomeResult> => {
  const bannerId = `rate-limit-${providerSlug}-${error.sessionId ?? String(attemptIdx + 1)}`;
  eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${providerName}: rate-limit on attempt ${String(attemptIdx + 1)}/${String(maxAttempts)}`,
    meta: { attempt: attemptIdx + 1, maxAttempts, subCode: error.subCode },
    at: IsoTimestamp.now(),
  });
  // A 429 before any session id leaves nothing to resume, so the next attempt is cold.
  const nextSession = error.sessionId !== undefined ? withResume(session, error.sessionId) : session;

  if (attemptIdx >= maxAttempts - 1) {
    return { type: 'continue', session: nextSession };
  }
  // Jitter keeps parallel branches that hit one account-level limit from waking in lockstep.
  const delayMs = applyJitter(
    delayForRetry(attemptIdx + 1, backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE),
    random ?? Math.random
  );
  if (delayMs <= 0) {
    return { type: 'continue', session: nextSession };
  }

  eventBus.publish({
    type: 'log',
    level: 'info',
    message: `${providerName}: waiting ${String(delayMs)}ms before retry`,
    meta: { delayMs, nextAttempt: attemptIdx + 2, maxAttempts },
    at: IsoTimestamp.now(),
  });
  eventBus.publish({
    type: 'banner-show',
    id: bannerId,
    tier: 'info',
    message: `Rate limit (${providerSlug}) — waiting ${Math.round(delayMs / 1000).toString()}s before retry`,
    cause: `attempt ${String(attemptIdx + 1)}/${String(maxAttempts)}`,
    at: IsoTimestamp.now(),
  });
  await sleepCancellable(delayMs, nextSession.abortSignal);
  eventBus.publish({ type: 'banner-clear', id: bannerId, at: IsoTimestamp.now() });
  if (nextSession.abortSignal?.aborted === true) {
    return { type: 'aborted', error: abortedByCaller(providerName, ' during rate-limit backoff') };
  }
  return { type: 'continue', session: nextSession };
};

const shouldColdRetry = (
  outcome: Extract<AttemptOutcome, { readonly kind: 'error' }>,
  session: AiSession,
  resumeStaleRe: RegExp,
  coldRetried: boolean
): boolean =>
  !coldRetried &&
  session.abortSignal?.aborted !== true &&
  session.resume !== undefined &&
  resumeStaleRe.test(outcome.error.message);

const logColdRetry = (eventBus: EventBus, providerName: string, session: AiSession): void => {
  eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${providerName}: resume thread not found — retrying cold (dropping --resume)`,
    meta: { resume: String(session.resume) },
    at: IsoTimestamp.now(),
  });
};

export const runWithRateLimitRetry = async (
  opts: RunWithRateLimitRetryOptions
): Promise<Result<ProviderOutput, DomainError>> => {
  const { eventBus, providerName, resumeStaleRe, attempt } = opts;
  const maxAttempts = opts.rateLimitRetries + 1;

  let session = opts.session;
  let coldRetried = false;
  let lastRateLimit: RateLimitError | undefined;

  for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
    const outcome = await attempt(session);
    if (outcome.kind === 'success') return Result.ok(outcome.output);

    if (outcome.kind === 'rate-limit') {
      lastRateLimit = outcome.error;
      const result = await handleRateLimitOutcome(opts, { session, attemptIdx, maxAttempts, error: outcome.error });
      if (result.type === 'aborted') return Result.error(result.error);
      session = result.session;
      continue;
    }

    if (shouldColdRetry(outcome, session, resumeStaleRe, coldRetried)) {
      coldRetried = true;
      logColdRetry(eventBus, providerName, session);
      session = withoutResume(session);
      // Re-run the SAME attempt index: the cold fallback must not consume a rate-limit slot.
      attemptIdx--;
      continue;
    }

    return Result.error(outcome.error);
  }

  return Result.error(
    lastRateLimit ?? new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limit retries exhausted' })
  );
};
