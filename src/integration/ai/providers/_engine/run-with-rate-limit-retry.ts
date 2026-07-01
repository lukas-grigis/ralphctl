import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { AttemptOutcome } from '@src/integration/ai/providers/_engine/attempt-outcome.ts';
import type { ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  delayForRetry,
  sleepCancellable,
} from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';

/**
 * Shared rate-limit retry loop for the three headless AI provider adapters
 * (claude / codex / copilot). Each adapter was carrying a near-identical ~70-line loop that
 * built argv ONCE before the loop and reused it verbatim every attempt — so the `sessionId`
 * `classifySpawnExit` captured onto a {@link RateLimitError} was never consumed: a 429 retry
 * re-spawned a COLD session instead of resuming the interrupted one. Centralising the loop here
 * fixes that for all three at once and removes the triplication.
 *
 * The seam: the adapter supplies an `attempt(session)` function that takes the CURRENT session
 * and builds its own argv from it, then runs one spawn and returns an {@link AttemptOutcome}.
 * On a rate-limit outcome whose `error.sessionId` is defined, the loop rebuilds the next
 * attempt's session as `{ ...session, resume: <captured id> }` so the provider continues from
 * where it stopped (`--resume` / `exec resume`). The adapter never re-implements backoff,
 * banner emission, abort-during-backoff, or the resume-rebuild — only the per-attempt spawn.
 *
 * Stale-resume cold fallback (was codex-only; now shared — FINDING 4). When an attempt fails
 * with an `error` outcome whose message matches the adapter's optional `resumeStaleRe`, the
 * resume id is dropped for ONE cold respawn (latched via `coldRetried`, fired at most once per
 * call). The cold retry MUST NOT consume a rate-limit slot — it re-runs the SAME attempt index
 * (the loop does not advance `attempt`), so a lost rollout / unknown-resume-id self-heals
 * without burning the 429 budget. An aborted run is exempt: a user cancel tears the run down
 * rather than spawning fresh work a competitor may now own.
 *
 * Observable semantics preserved per adapter:
 *  - backoff schedule (`rate-limit-backoff.ts`, overridable for tests),
 *  - abort-during-backoff → {@link AbortError} (the one error chains propagate transparently),
 *  - the rate-limit banner-show / banner-clear pair keyed by `<providerSlug>-<id|attempt>`,
 *  - codex's exec-resume invocation form (the adapter's own `attempt` rebuilds argv from the
 *    resumed session, so `buildCodexArgs` takes the `exec resume <id>` path unchanged).
 */

export interface RunWithRateLimitRetryOptions {
  /** The initial session — the first attempt runs with this; retries rebuild it with `resume`. */
  readonly session: AiSession;
  /** Adapter-side retries on `RateLimitError` before surfacing the failure. */
  readonly rateLimitRetries: number;
  /** Wait schedule between retries. Defaults to {@link DEFAULT_BACKOFF_SCHEDULE}. */
  readonly backoffSchedule?: readonly number[];
  readonly eventBus: EventBus;
  /**
   * Short provider tag for log lines / banner ids (`'claude'` / `'codex'` / `'copilot'`). Keeps
   * the banner id keyspace per-provider so concurrent adapters don't collide.
   */
  readonly providerSlug: 'claude' | 'codex' | 'copilot';
  /**
   * Element name stamped onto the {@link AbortError} surfaced when a user cancel lands during a
   * backoff sleep — mirrors `classifySpawnExit`'s abort shape so the chain runner propagates it.
   */
  readonly providerName: string;
  /**
   * Optional stale-resume regex. When a non-rate-limit `error` outcome's message matches AND the
   * session carries a `resume` id, the loop drops `resume` for one cold respawn (latched). Codex
   * passes its `RESUME_STALE_RE`; claude / copilot pass their own conservative wording. Omit to
   * disable the cold-fallback (hard-fail on a dead resume id, the legacy claude/copilot path).
   */
  readonly resumeStaleRe?: RegExp;
  /**
   * One spawn attempt against `session`. The adapter builds argv from `session` here, so the
   * resume-rebuilt session naturally produces resume argv. Returns the classifier's outcome.
   */
  readonly attempt: (session: AiSession) => Promise<AttemptOutcome>;
}

/**
 * Rebuild a session for the next attempt with `resume` set to the captured id. Uses a spread so
 * the caller's session is never mutated; `exactOptionalPropertyTypes` is satisfied because we
 * always assign a concrete value (never `resume: undefined`).
 */
const withResume = (session: AiSession, resumeId: string): AiSession => ({
  ...session,
  resume: resumeId as SessionId,
});

/**
 * Drop the resume id so the adapter's argv builder takes the cold-start path. `delete` on a
 * spread copy (never the caller's session) — `exactOptionalPropertyTypes` forbids re-setting
 * `resume: undefined`, so omit the key entirely.
 */
const withoutResume = (session: AiSession): AiSession => {
  const cold: AiSession = { ...session };
  delete (cold as { resume?: unknown }).resume;
  return cold;
};

interface HandleRateLimitOutcomeParams {
  readonly eventBus: EventBus;
  readonly providerSlug: RunWithRateLimitRetryOptions['providerSlug'];
  readonly providerName: string;
  readonly session: AiSession;
  readonly attemptIdx: number;
  readonly maxAttempts: number;
  readonly schedule: readonly number[];
  readonly error: RateLimitError;
}

/**
 * Result of one rate-limit-outcome handling pass: either an abort surfaced during the backoff
 * sleep (caller must stop and return it), or the rebuilt session the loop should retry with.
 */
type RateLimitOutcomeResult =
  { readonly type: 'aborted'; readonly error: AbortError } | { readonly type: 'continue'; readonly session: AiSession };

/**
 * Handle one `rate-limit` attempt outcome: warn-log, rebuild the session with the captured
 * resume id (if any), and — unless this was the last allotted attempt — wait out the backoff
 * schedule behind a show/clear banner pair, short-circuiting on abort. Pulled out of the main
 * loop body purely to keep that loop under the complexity/line thresholds; same publishes, same
 * ordering, same abort semantics as before.
 */
const handleRateLimitOutcome = async ({
  eventBus,
  providerSlug,
  providerName,
  session,
  attemptIdx,
  maxAttempts,
  schedule,
  error,
}: HandleRateLimitOutcomeParams): Promise<RateLimitOutcomeResult> => {
  const bannerId = `rate-limit-${providerSlug}-${error.sessionId ?? String(attemptIdx + 1)}`;
  eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `${providerName}: rate-limit on attempt ${String(attemptIdx + 1)}/${String(maxAttempts)}`,
    meta: { attempt: attemptIdx + 1, maxAttempts, subCode: error.subCode },
    at: IsoTimestamp.now(),
  });
  // Carry the interrupted session forward so the retry resumes it instead of cold-starting.
  // Only when the provider captured an id — a 429 before any session id leaves nothing to
  // resume, so the next attempt is necessarily cold.
  const nextSession = error.sessionId !== undefined ? withResume(session, error.sessionId) : session;

  // Wait before retrying — gives a daily-quota throttle a chance to reset on a fresh window.
  // Only between attempts, not after the last one. Abort short-circuits the sleep so a
  // user-initiated cancel doesn't have to wait through a multi-hour backoff.
  if (attemptIdx >= maxAttempts - 1) {
    return { type: 'continue', session: nextSession };
  }
  const delayMs = delayForRetry(attemptIdx + 1, schedule);
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
  // Clear once the wait completes (either elapsed or abort fired); the next attempt
  // re-publishes if it also hits the rate-limit.
  eventBus.publish({ type: 'banner-clear', id: bannerId, at: IsoTimestamp.now() });
  if (nextSession.abortSignal?.aborted === true) {
    // User cancel during the backoff sleep must surface as AbortError — the one error
    // chains propagate transparently (CLAUDE.md §AbortError). InvalidStateError is
    // classified as a recoverable turn error and would wrongly self-block the task.
    // Mirrors the abort-on-exit shape in classify-spawn-exit.ts.
    return {
      type: 'aborted',
      error: new AbortError({
        elementName: providerName,
        reason: `${providerName}: aborted by caller during rate-limit backoff`,
      }),
    };
  }
  return { type: 'continue', session: nextSession };
};

/**
 * Stale-resume cold fallback predicate (FINDING 4 — shared, was codex-only). A `resume` spawn
 * that failed because the provider no longer has the session/thread would otherwise block the
 * task; the caller falls back to a COLD spawn (no resume) exactly once when this returns `true`.
 * An aborted run is exempt: a user cancel must tear the run down, not spawn fresh work a
 * competitor may now own.
 */
const shouldColdRetry = (
  outcome: Extract<AttemptOutcome, { readonly kind: 'error' }>,
  session: AiSession,
  resumeStaleRe: RegExp | undefined,
  coldRetried: boolean
): boolean =>
  resumeStaleRe !== undefined &&
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
  const { eventBus, providerSlug, providerName, resumeStaleRe, attempt } = opts;
  const schedule = opts.backoffSchedule ?? DEFAULT_BACKOFF_SCHEDULE;
  // attempt 0 = first try; up to `rateLimitRetries` extra attempts after a rate-limit.
  const maxAttempts = opts.rateLimitRetries + 1;

  // Current session for this attempt — retries rebuild it with the captured resume id; the
  // stale-resume cold fallback rebuilds it without one.
  let session = opts.session;
  // Latch so the stale-resume cold fallback fires at most once per call.
  let coldRetried = false;
  let lastRateLimit: RateLimitError | undefined;

  for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
    const outcome = await attempt(session);
    if (outcome.kind === 'success') {
      return Result.ok(outcome.output) as Result<ProviderOutput, DomainError>;
    }

    if (outcome.kind === 'rate-limit') {
      lastRateLimit = outcome.error;
      const result = await handleRateLimitOutcome({
        eventBus,
        providerSlug,
        providerName,
        session,
        attemptIdx,
        maxAttempts,
        schedule,
        error: outcome.error,
      });
      if (result.type === 'aborted') {
        return Result.error(result.error) as Result<ProviderOutput, DomainError>;
      }
      session = result.session;
      continue;
    }

    // Re-running the SAME attempt index keeps the cold fallback from consuming a rate-limit
    // slot; see `shouldColdRetry` for the full rationale.
    if (shouldColdRetry(outcome, session, resumeStaleRe, coldRetried)) {
      coldRetried = true;
      logColdRetry(eventBus, providerName, session);
      session = withoutResume(session);
      attemptIdx--;
      continue;
    }

    return Result.error(outcome.error) as Result<ProviderOutput, DomainError>;
  }

  return Result.error(
    lastRateLimit ?? new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limit retries exhausted' })
  ) as Result<ProviderOutput, DomainError>;
};
