import { describe, expect, it } from 'vitest';
import { abortCauseFromError } from '@src/business/task/abort-cause-from-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';

describe('abortCauseFromError', () => {
  it('maps a watchdog-marked crash to `watchdog-killed`, keeping the reported signal', () => {
    const meta = abortCauseFromError(
      new ProcessCrashError({
        entity: 'claude-provider',
        state: 'exit-143',
        message: 'killed',
        signalOrExitCode: 'SIGTERM',
        watchdogKilled: true,
      })
    );

    expect(meta).toEqual({ abortCause: 'watchdog-killed', signalOrExitCode: 'SIGTERM' });
  });

  it('maps an unmarked crash to `process-crash` — a SIGTERM we did not send is not a watchdog kill', () => {
    const meta = abortCauseFromError(
      new ProcessCrashError({
        entity: 'codex-provider',
        state: 'exit-143',
        message: 'killed',
        signalOrExitCode: 'SIGTERM',
      })
    );

    expect(meta).toEqual({ abortCause: 'process-crash', signalOrExitCode: 'SIGTERM' });
  });

  it('omits signalOrExitCode when the crash reported none (a spawn failure never ran)', () => {
    const meta = abortCauseFromError(
      new ProcessCrashError({ entity: 'copilot-provider', state: 'spawn-failed', message: 'ENOENT' })
    );

    expect(meta).toEqual({ abortCause: 'process-crash' });
  });

  it('attributes nothing for the two fatal codes — they tear the chain down before any settle runs', () => {
    // Documented gap, not an oversight: `rate-limit-exhausted` / `user-cancel` need a
    // settle-then-re-raise seam at the turn boundary, which does not exist yet.
    expect(abortCauseFromError(new RateLimitError({ subCode: 'spawn-stderr', message: 'exhausted' }))).toBeUndefined();
    expect(abortCauseFromError(new AbortError({ elementName: 'generator', reason: 'ctrl-c' }))).toBeUndefined();
  });

  it('attributes nothing for a signals-contract failure — the task self-blocked, nothing was killed', () => {
    expect(
      abortCauseFromError(new ParseError({ subCode: 'schema-mismatch', message: 'signals-invalid (schema) at root' }))
    ).toBeUndefined();
  });
});
