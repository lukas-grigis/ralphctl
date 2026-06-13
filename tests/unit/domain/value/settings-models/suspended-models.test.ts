import { describe, expect, it } from 'vitest';
import {
  isSuspendedModel,
  SUSPENDED_MODELS,
  SUSPENSION_NOTE,
  suspendedModelMessage,
} from '@src/domain/value/settings-models/suspended-models.ts';

describe('suspended-models', () => {
  it('flags both fable ids as suspended', () => {
    expect(isSuspendedModel('claude-fable-5')).toBe(true);
    expect(isSuspendedModel('claude-fable-5[1m]')).toBe(true);
  });

  it('does not flag a live catalog model, a custom string, or empty', () => {
    expect(isSuspendedModel('claude-opus-4-8')).toBe(false);
    expect(isSuspendedModel('my-custom-model')).toBe(false);
    expect(isSuspendedModel('')).toBe(false);
  });

  it('SUSPENDED_MODELS contains exactly the two fable ids', () => {
    expect([...SUSPENDED_MODELS].sort()).toEqual(['claude-fable-5', 'claude-fable-5[1m]']);
  });

  it('message names the model and carries the suspension note tag', () => {
    const msg = suspendedModelMessage('claude-fable-5');
    expect(msg).toContain("'claude-fable-5'");
    expect(msg).toContain(SUSPENSION_NOTE);
    expect(SUSPENSION_NOTE).toBe('suspended');
  });
});
