import { describe, expect, it } from 'vitest';
import {
  isSuspendedModel,
  SUSPENDED_MODELS,
  SUSPENSION_NOTE,
  suspendedModelMessage,
} from '@src/domain/value/settings-models/suspended-models.ts';

describe('suspended-models', () => {
  it('SUSPENDED_MODELS is empty — the kill-switch mechanism is deliberately retained with no active entries', () => {
    expect(SUSPENDED_MODELS).toEqual([]);
  });

  it('does not flag any model as suspended (fable is un-suspended, GA again)', () => {
    expect(isSuspendedModel('claude-fable-5')).toBe(false);
    expect(isSuspendedModel('claude-fable-5[1m]')).toBe(false);
    expect(isSuspendedModel('claude-opus-5')).toBe(false);
    expect(isSuspendedModel('')).toBe(false);
  });

  it('message names the model and carries the suspension note tag', () => {
    const msg = suspendedModelMessage('x');
    expect(msg).toContain('x');
    expect(msg).toContain('suspended');
    expect(SUSPENSION_NOTE).toBe('suspended');
  });
});
