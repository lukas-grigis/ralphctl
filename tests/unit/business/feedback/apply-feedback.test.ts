import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { applyFeedbackUseCase } from '@src/business/feedback/apply-feedback.ts';

describe('applyFeedbackUseCase', () => {
  it('returns the parsed signals on success', async () => {
    const signals: readonly HarnessSignal[] = [{ type: 'note', text: 'hello', timestamp: FIXED_NOW }];
    const result = await applyFeedbackUseCase({
      callApply: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signals).toEqual(signals);
      expect(result.value.blockedReason).toBeUndefined();
    }
  });

  it('captures blockedReason when <task-blocked> is among the signals', async () => {
    const signals: readonly HarnessSignal[] = [{ type: 'task-blocked', reason: 'no API key', timestamp: FIXED_NOW }];
    const result = await applyFeedbackUseCase({
      callApply: async () => Result.ok(signals),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.blockedReason).toBe('no API key');
  });

  it('forwards an AI call error', async () => {
    const err = new ValidationError({ field: 'ai', value: 0, message: 'boom' });
    const result = await applyFeedbackUseCase({
      callApply: async () => Result.error(err),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(err);
  });
});
