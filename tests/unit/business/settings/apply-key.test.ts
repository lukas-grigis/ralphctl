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

  it('updates a per-flow model under ai.<flow>.model', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.plan.model', 'claude-haiku-4-5');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.plan.model).toBe('claude-haiku-4-5');
  });

  it('updates a per-flow effort under ai.<flow>.effort', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.effort', 'xhigh');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.implement.effort).toBe('xhigh');
  });

  it('clears a per-flow effort when given an empty string', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.effort', 'xhigh');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const cleared = applySettingsKey(seeded.value, 'ai.implement.effort', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.ai.implement.effort).toBeUndefined();
  });

  it('updates the global ai.effort default', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.effort', 'high');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.effort).toBe('high');
  });

  it('updates a per-flow provider under ai.<flow>.provider', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.refine.provider', 'github-copilot');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.refine.provider).toBe('github-copilot');
  });

  it('rejects ai.provider (v1 key) with `unknown settings key`', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.provider', 'openai-codex');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('unknown settings key');
    }
  });

  it('rejects ai.models.<flow> (v1 key) with `unknown settings key`', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.models.plan', 'claude-opus-4-7');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('unknown settings key');
    }
  });

  it('rejects an unknown provider value', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.refine.provider', 'not-a-provider');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a recognised provider');
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

  it('toggles ui.notifications.enabled from common truthy/falsy synonyms', () => {
    for (const raw of ['true', '1', 'yes', 'on'] as const) {
      const r = applySettingsKey(DEFAULT_SETTINGS, 'ui.notifications.enabled', raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.ui.notifications.enabled).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off'] as const) {
      const r = applySettingsKey(DEFAULT_SETTINGS, 'ui.notifications.enabled', raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.ui.notifications.enabled).toBe(false);
    }
  });

  it('rejects a non-boolean value for ui.notifications.enabled', () => {
    const r = applySettingsKey(DEFAULT_SETTINGS, 'ui.notifications.enabled', 'maybe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('not a boolean');
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
