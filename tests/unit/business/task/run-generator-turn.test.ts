import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
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

  it('forwards the AI provider error', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const err = new ValidationError({ field: 'ai', value: 0, message: 'boom' });
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
