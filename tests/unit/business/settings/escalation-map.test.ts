/**
 * Settings-side contract for the new `harness.escalateOnPlateau` and `harness.escalationMap`
 * fields: schema rejects non-string entries; fresh-install defaults are off / empty;
 * `applySettingsKey` round-trips both keys; the per-entry setter clears on empty input.
 */

import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';

const baseRecord = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ai: {
    refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
    implement: {
      generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
      evaluator: { provider: 'claude-code', model: 'claude-opus-4-8' },
    },
    readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  },
  harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  ui: { notifications: { enabled: true } },
  developer: { showEvaluatorFailureUI: false },
};

describe('settings.harness — escalateOnPlateau + escalationMap', () => {
  it('fresh-install defaults are off / empty', () => {
    expect(DEFAULT_SETTINGS.harness.escalateOnPlateau).toBe(false);
    expect(DEFAULT_SETTINGS.harness.escalationMap).toEqual({});
  });

  it('rejects an escalationMap entry whose value is a number with an `expected string` error naming the field', () => {
    const record = {
      ...baseRecord,
      harness: {
        ...baseRecord.harness,
        escalationMap: { foo: 42 },
      },
    };
    const parsed = SettingsSchema.safeParse(record);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const offending = parsed.error.issues.find((issue) => issue.path.join('.') === 'harness.escalationMap.foo');
    expect(offending).toBeDefined();
    expect(offending?.message.toLowerCase()).toContain('string');
  });

  it('rejects an escalationMap entry whose value is null with an `expected string` error', () => {
    const record = {
      ...baseRecord,
      harness: {
        ...baseRecord.harness,
        escalationMap: { foo: null },
      },
    };
    const parsed = SettingsSchema.safeParse(record);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const offending = parsed.error.issues.find((issue) => issue.path.join('.') === 'harness.escalationMap.foo');
    expect(offending).toBeDefined();
    expect(offending?.message.toLowerCase()).toContain('string');
  });

  it('parses an escalationMap with valid string→string entries', () => {
    const record = {
      ...baseRecord,
      harness: {
        ...baseRecord.harness,
        escalateOnPlateau: true,
        escalationMap: { 'claude-sonnet-4-6': 'claude-opus-4-8' },
      },
    };
    const parsed = SettingsSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.escalateOnPlateau).toBe(true);
    expect(parsed.data.harness.escalationMap).toEqual({
      'claude-sonnet-4-6': 'claude-opus-4-8',
    });
  });

  it('fills in defaults for both fields when the harness section omits them', () => {
    const record = {
      ...baseRecord,
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
    };
    const parsed = SettingsSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.escalateOnPlateau).toBe(false);
    expect(parsed.data.harness.escalationMap).toEqual({});
  });
});

describe('applySettingsKey — escalation keys', () => {
  it('round-trips harness.escalateOnPlateau=true', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalateOnPlateau', 'true');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.escalateOnPlateau).toBe(true);
  });

  it('accepts boolean synonyms (1/yes/on, 0/no/off) for harness.escalateOnPlateau', () => {
    for (const raw of ['true', '1', 'yes', 'on'] as const) {
      const r = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalateOnPlateau', raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.harness.escalateOnPlateau).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off'] as const) {
      const r = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalateOnPlateau', raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.harness.escalateOnPlateau).toBe(false);
    }
  });

  it('rejects a non-boolean value for harness.escalateOnPlateau', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalateOnPlateau', 'maybe');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a boolean');
  });

  it('sets harness.escalationMap.<fromModel> to the upgraded model id', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalationMap.foo', 'bar');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.escalationMap).toEqual({ foo: 'bar' });
  });

  it('overwrites an existing escalationMap entry when set a second time', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalationMap.foo', 'bar');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const overwritten = applySettingsKey(seeded.value, 'harness.escalationMap.foo', 'baz');
    expect(overwritten.ok).toBe(true);
    if (overwritten.ok) expect(overwritten.value.harness.escalationMap).toEqual({ foo: 'baz' });
  });

  it('clears an escalationMap entry when given an empty value', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalationMap.foo', 'bar');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const cleared = applySettingsKey(seeded.value, 'harness.escalationMap.foo', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.harness.escalationMap).toEqual({});
  });

  it('rejects harness.escalationMap. with no source model id', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.escalationMap.', 'bar');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('missing the source model id');
  });
});
