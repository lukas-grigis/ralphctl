import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applySettingsKey, parseSettingsKvSyntax } from '@src/business/settings/apply-key.ts';

describe('applySettingsKey', () => {
  it('updates harness.maxTurns numerically', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.maxTurns', '7');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.maxTurns).toBe(7);
  });

  it('updates logging.level as a string', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'logging.level', 'debug');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.logging.level).toBe('debug');
  });

  it('updates a per-chain model under ai.models', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.models.plan', 'claude-haiku-4-5');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.models.plan).toBe('claude-haiku-4-5');
  });

  it('rejects ai.provider alone (would leave models incoherent)', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.provider', 'openai-codex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects a non-numeric value for a numeric field', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.maxTurns', 'NaN');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a number');
  });

  it('rejects an unknown key', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'foo.bar', 'baz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown settings key');
  });
});

describe('parseSettingsKvSyntax', () => {
  it('splits on the first =', () => {
    expect(parseSettingsKvSyntax('a=b')).toEqual({ key: 'a', value: 'b' });
    expect(parseSettingsKvSyntax('logging.level=info')).toEqual({ key: 'logging.level', value: 'info' });
  });

  it('trims whitespace', () => {
    expect(parseSettingsKvSyntax('  k  =  v  ')).toEqual({ key: 'k', value: 'v' });
  });

  it('preserves additional = inside the value', () => {
    expect(parseSettingsKvSyntax('k=a=b=c')).toEqual({ key: 'k', value: 'a=b=c' });
  });

  it('returns undefined for malformed input', () => {
    expect(parseSettingsKvSyntax('no-equals')).toBeUndefined();
    expect(parseSettingsKvSyntax('=value')).toBeUndefined();
  });
});
