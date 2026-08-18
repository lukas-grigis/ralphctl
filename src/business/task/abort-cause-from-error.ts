import type { AbortMetadata } from '@src/domain/entity/attempt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';

/**
 * Attribute an AI-turn failure to an {@link AbortMetadata} pair the attempt record can carry.
 *
 * Only a {@link ProcessCrashError} maps here, and deliberately so: it is the one terminal turn
 * error that stays INSIDE the run (the turn policy converts it into a `crashed` gen-eval exit,
 * which finalize retries and — once the budget is gone — turns into the block that settles the
 * running attempt as `aborted`). The two fatal codes (`Aborted`, `RateLimit`) tear the chain down
 * from the turn use case, so no settle ever observes them in-process; attributing them needs a
 * settle-then-re-raise seam that does not exist yet, and inventing a cause here would only
 * produce a mapping nothing calls.
 *
 * `watchdogKilled` is the discriminator between the taxonomy's `watchdog-killed` and the generic
 * `process-crash`: the idle-stdout watchdog's SIGTERM and an external kill produce the same exit
 * shape, so the marker is set at the spawn site that owns the watchdog rather than inferred from
 * `exit-143` here.
 */
export const abortCauseFromError = (err: DomainError): AbortMetadata | undefined => {
  if (!(err instanceof ProcessCrashError)) return undefined;
  return {
    abortCause: err.watchdogKilled === true ? 'watchdog-killed' : 'process-crash',
    ...(err.signalOrExitCode !== undefined ? { signalOrExitCode: err.signalOrExitCode } : {}),
  };
};
