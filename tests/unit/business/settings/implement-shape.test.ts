/**
 * Shape contract for `settings.ai.implement`: the row is `{ generator, evaluator }`, the
 * flat legacy form is silently promoted at parse time, and a partially-specified pair is
 * rejected with a missing-role error.
 *
 * These tests pin the contract that downstream consumers (provider factory, presets,
 * settings TUI) rely on — touching the schema, the legacy promotion, or the defaults
 * surface a focused failure here before propagating to broader integration tests.
 */

import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const baseRecord = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ai: {
    refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
    readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  },
  harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
  logging: { level: 'info' },
  concurrency: { maxParallelTasks: 1 },
  ui: { notifications: { enabled: true } },
  developer: { showEvaluatorFailureUI: false },
};

describe('settings.ai.implement — nested generator/evaluator shape', () => {
  it('fresh-install defaults split implement across providers (generator=Claude, evaluator=Codex)', () => {
    expect(DEFAULT_SETTINGS.ai.implement.generator).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-4-8',
    });
    expect(DEFAULT_SETTINGS.ai.implement.evaluator).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.5',
    });
  });

  it('silently promotes a legacy flat implement row to {generator, evaluator} with both roles equal', () => {
    const legacyFlat = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { provider: 'claude-code', model: 'claude-opus-4-8' },
      },
    };
    const parsed = SettingsSchema.safeParse(legacyFlat);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const expectedRow = { provider: 'claude-code', model: 'claude-opus-4-8' };
    expect(parsed.data.ai.implement).toEqual({ generator: expectedRow, evaluator: expectedRow });
    // schemaVersion stays at v2 — silent promotion does NOT bump the persisted version.
    expect(parsed.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('promotes a flat implement row that carries an explicit effort', () => {
    const legacyFlat = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
      },
    };
    const parsed = SettingsSchema.safeParse(legacyFlat);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const expectedRow = { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' };
    expect(parsed.data.ai.implement.generator).toEqual(expectedRow);
    expect(parsed.data.ai.implement.evaluator).toEqual(expectedRow);
  });

  it('rejects a partial implement that supplies only generator with a missing-role error', () => {
    const partial = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { generator: { provider: 'claude-code', model: 'claude-opus-4-8' } },
      },
    };
    const parsed = SettingsSchema.safeParse(partial);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = JSON.stringify(parsed.error.issues);
    expect(message).toContain('evaluator');
  });

  it('rejects a partial implement that supplies only evaluator with a missing-role error', () => {
    const partial = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { evaluator: { provider: 'openai-codex', model: 'gpt-5.5' } },
      },
    };
    const parsed = SettingsSchema.safeParse(partial);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = JSON.stringify(parsed.error.issues);
    expect(message).toContain('generator');
  });

  it('accepts a cross-provider implement (generator on Claude, evaluator on Codex)', () => {
    const crossProvider = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
        },
      },
    };
    const parsed = SettingsSchema.safeParse(crossProvider);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.generator.provider).toBe('claude-code');
    expect(parsed.data.ai.implement.evaluator.provider).toBe('openai-codex');
  });
});

describe('settings.ai — retired claude-opus-4-7 migration', () => {
  const nestedImplement = {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
  };

  it('rewrites a flat row pinned to claude-opus-4-7 to claude-opus-4-8 at parse time', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        plan: { provider: 'claude-code', model: 'claude-opus-4-7' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.plan).toEqual({ provider: 'claude-code', model: 'claude-opus-4-8' });
    // Silent migration does NOT bump the persisted version.
    expect(parsed.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rewrites both nested implement roles pinned to claude-opus-4-7', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
          evaluator: { provider: 'claude-code', model: 'claude-opus-4-7' },
        },
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.generator.model).toBe('claude-opus-4-8');
    expect(parsed.data.ai.implement.evaluator.model).toBe('claude-opus-4-8');
  });

  it('leaves a non-claude-code row untouched even if its model string collides', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        // Off-catalog custom string on a Codex row — provider guard must spare it.
        plan: { provider: 'openai-codex', model: 'claude-opus-4-7' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.plan).toEqual({ provider: 'openai-codex', model: 'claude-opus-4-7' });
  });

  it('promotes a legacy flat implement row of claude-opus-4-7 and migrates BOTH roles (ordering proof)', () => {
    const legacyFlatStale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { provider: 'claude-code', model: 'claude-opus-4-7' },
      },
    };
    const parsed = SettingsSchema.safeParse(legacyFlatStale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const expectedRow = { provider: 'claude-code', model: 'claude-opus-4-8' };
    expect(parsed.data.ai.implement).toEqual({ generator: expectedRow, evaluator: expectedRow });
  });
});
