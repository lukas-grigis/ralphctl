import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ProcessCrashError } from '@src/domain/value/error/process-crash-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { runGeneratorTurnUseCase } from '@src/business/task/run-generator-turn.ts';

describe('runGeneratorTurnUseCase', () => {
  it('records the structural verification marker when the generator succeeds', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.ok([] as readonly HarnessSignal[]),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBeUndefined();
      const last = result.value.task.attempts.at(-1);
      // Structural marker — presence proves verification, no body persisted.
      expect(last?.verification).toEqual({});
    }
  });

  it('returns self-blocked exit when <task-blocked> signal is present', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const signals: readonly HarnessSignal[] = [
      { type: 'task-blocked', reason: 'missing API key', timestamp: FIXED_NOW },
    ];
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toEqual({ kind: 'self-blocked', reason: 'missing API key' });
      expect(result.value.task).toBe(task); // unchanged when blocked
    }
  });

  it('blocks the task (self-blocked exit) on a recoverable signals-contract failure — does NOT propagate', async () => {
    // A non-Claude provider that wrote a malformed signals.json surfaces a ParseError. The
    // turn must self-block THIS task (so it surfaces + re-runs) rather than abort the whole run.
    const task = makeInProgressTaskWithRunningAttempt();
    const err = new ParseError({ subCode: 'schema-mismatch', message: 'signals-invalid (schema) at root' });
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.error(err),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('self-blocked');
      // The precise validator message lands in the block reason for the operator / progress.md.
      expect(result.value.exit?.reason).toContain('generator did not produce a valid signals.json');
      expect(result.value.exit?.reason).toContain('signals-invalid (schema) at root');
      expect(result.value.task).toBe(task); // unchanged — no verification recorded
    }
  });

  it('returns a CRASHED exit (not self-blocked) on a ProcessCrashError — the retry path', async () => {
    // A watchdog kill / spawn crash surfaces a ProcessCrashError. Unlike a signals-contract
    // ParseError (which self-blocks), a crash must route to a `crashed` exit so finalize retries
    // the attempt within maxAttempts instead of terminally blocking after one. The crash message
    // rides the exit reason for the operator / progress.md.
    const task = makeInProgressTaskWithRunningAttempt();
    const err = new ProcessCrashError({
      entity: 'claude-provider',
      state: 'exit-143',
      message: 'claude-provider: process exited with code 143 (signal=SIGTERM): <empty stderr>',
    });
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.error(err),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit?.kind).toBe('crashed');
      expect(result.value.exit?.reason).toContain('AI process was killed before producing signals.json');
      expect(result.value.exit?.reason).toContain('process exited with code 143 (signal=SIGTERM)');
      expect(result.value.task).toBe(task); // unchanged — no verification recorded on a crash
    }
  });

  it('propagates an AbortError (user cancel) instead of blocking', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const err = new AbortError({ elementName: 'codex-provider', reason: 'aborted by caller' });
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.error(err),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
  });

  it('propagates a RateLimitError (retries already exhausted) instead of blocking', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const err = new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limit retries exhausted' });
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.error(err),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
  });

  it('forwards a commit-message signal as proposedCommitMessage', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const signals: readonly HarnessSignal[] = [
      {
        type: 'commit-message',
        subject: 'add user-id index',
        body: 'Speeds up the session lookup hot path.',
        timestamp: FIXED_NOW,
      },
    ];
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.proposedCommitMessage).toEqual({
        subject: 'add user-id index',
        body: 'Speeds up the session lookup hot path.',
      });
    }
  });

  it('picks the last commit-message signal when several are emitted', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const signals: readonly HarnessSignal[] = [
      { type: 'commit-message', subject: 'first', timestamp: FIXED_NOW },
      { type: 'commit-message', subject: 'second', timestamp: FIXED_NOW },
    ];
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.proposedCommitMessage?.subject).toBe('second');
  });

  it('still forwards the commit-message even when the turn self-blocks', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const signals: readonly HarnessSignal[] = [
      { type: 'commit-message', subject: 'partial progress', timestamp: FIXED_NOW },
      { type: 'task-blocked', reason: 'needs API key', timestamp: FIXED_NOW },
    ];
    const result = await runGeneratorTurnUseCase({
      task,
      callImplement: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toEqual({ kind: 'self-blocked', reason: 'needs API key' });
      expect(result.value.proposedCommitMessage?.subject).toBe('partial progress');
    }
  });
});
