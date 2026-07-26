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
      model: 'claude-opus-5',
    });
    expect(DEFAULT_SETTINGS.ai.implement.evaluator).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
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

  it('rewrites a copilot flat row pinned to the delisted claude-opus-4.6-fast to claude-opus-4.8-fast', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        plan: { provider: 'github-copilot', model: 'claude-opus-4.6-fast' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.plan).toEqual({ provider: 'github-copilot', model: 'claude-opus-4.8-fast' });
    expect(parsed.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it.each(['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.3-codex-spark'])(
    'rewrites a codex flat row pinned to the removed %s to gpt-5.5',
    (removedModel) => {
      const stale = {
        ...baseRecord,
        ai: {
          ...baseRecord.ai,
          refine: { provider: 'openai-codex', model: removedModel },
          implement: nestedImplement,
        },
      };
      const parsed = SettingsSchema.safeParse(stale);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.ai.refine).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
    }
  );

  it('leaves a Copilot row pinned to gpt-5.3-codex untouched — still a live Copilot catalog member', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        // gpt-5.3-codex was removed from the codex catalog but GitHub still lists it for Copilot —
        // the remap is codex-provider-guarded, so this row must survive untouched.
        plan: { provider: 'github-copilot', model: 'gpt-5.3-codex' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.plan).toEqual({ provider: 'github-copilot', model: 'gpt-5.3-codex' });
  });

  it('rewrites both nested implement roles pinned to the removed gpt-5.2', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.2' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.2' },
        },
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.generator.model).toBe('gpt-5.5');
    expect(parsed.data.ai.implement.evaluator.model).toBe('gpt-5.5');
  });
});

describe("settings.ai — retired codex effort 'minimal' migration", () => {
  const nestedImplement = {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
  };

  it("rewrites a flat codex row's effort 'minimal' to 'low' at parse time", () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.refine).toEqual({ provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' });
  });

  it("heals both nested implement roles pinned to codex effort 'minimal'", () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
        },
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.generator.effort).toBe('low');
    expect(parsed.data.ai.implement.evaluator.effort).toBe('low');
  });

  it("promotes a legacy FLAT codex implement row with effort 'minimal' and heals both roles (ordering proof)", () => {
    const legacyFlatStale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        implement: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
      },
    };
    const parsed = SettingsSchema.safeParse(legacyFlatStale);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const expectedRow = { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' };
    expect(parsed.data.ai.implement).toEqual({ generator: expectedRow, evaluator: expectedRow });
  });

  it("leaves a codex row already at effort 'low' untouched (idempotence)", () => {
    const stable = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stable);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.refine).toEqual({ provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' });
  });

  it('never rewrites effort on a claude-code row, even one carrying an off-vocabulary string', () => {
    const stale = {
      ...baseRecord,
      ai: {
        ...baseRecord.ai,
        // Off-catalog custom string that happens to collide with the retired codex effort level —
        // the effort migration is provider-guarded to openai-codex only.
        readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'minimal' },
        implement: nestedImplement,
      },
    };
    const parsed = SettingsSchema.safeParse(stale);
    // claude-code's effort schema does not accept 'minimal' at all, so this row is expected to
    // fail validation rather than being silently rewritten — proving the migration never touches it.
    expect(parsed.success).toBe(false);
  });
});
