import { describe, expect, it } from 'vitest';
import { GROK_MODELS, isGrokModel } from '@src/domain/value/settings-models/grok.ts';

describe('settings-models / grok catalog', () => {
  it('recognizes every shipped id', () => {
    for (const m of GROK_MODELS) {
      expect(isGrokModel(m)).toBe(true);
    }
  });

  it('keeps grok-4.7 as the flagship first entry', () => {
    expect(GROK_MODELS[0]).toBe('grok-4.7');
    expect(GROK_MODELS).toContain('grok-4.7-build-fast');
    expect(GROK_MODELS).toContain('grok-4.6');
    expect(GROK_MODELS).toContain('grok-4.5');
  });

  it('rejects ids outside the shipped catalog', () => {
    expect(isGrokModel('gpt-5.5')).toBe(false);
    expect(isGrokModel('grok-3')).toBe(false);
    expect(isGrokModel('')).toBe(false);
  });
});
