import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, SettingsSchema, type Settings } from '@src/domain/entity/settings.ts';
import { applyMigrations } from '@src/business/settings/migrations.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';

describe('v1 → v2 settings migration', () => {
  it('expands the v1 single-provider shape into five per-flow rows and seeds effort', () => {
    const v1 = {
      schemaVersion: 1,
      ai: {
        provider: 'github-copilot',
        models: {
          refine: 'gpt-5-mini',
          plan: 'gpt-5.4',
          implement: 'gpt-5.4',
          readiness: 'gpt-5-mini',
          ideate: 'gpt-5-mini',
        },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
      developer: { showEvaluatorFailureUI: false },
    };
    const outcome = applyMigrations(v1);
    expect(outcome.fromVersion).toBe(1);
    expect(outcome.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    const parsed = SettingsSchema.safeParse(outcome.value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const ai = parsed.data.ai;
    expect(ai.effort).toBe('high');
    expect(ai.refine).toEqual({ provider: 'github-copilot', model: 'gpt-5-mini' });
    expect(ai.plan).toEqual({ provider: 'github-copilot', model: 'gpt-5.4', effort: 'xhigh' });
    // The v1→v2 migration writes the flat implement shape; the inline preprocess at parse
    // time then promotes it to {generator, evaluator} silently — both roles equal — so
    // legacy v1 files land in the canonical nested shape without bumping schemaVersion.
    const implementRow = { provider: 'github-copilot', model: 'gpt-5.4', effort: 'xhigh' };
    expect(ai.implement).toEqual({ generator: implementRow, evaluator: implementRow });
    expect(ai.readiness).toEqual({ provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' });
    expect(ai.ideate).toEqual({ provider: 'github-copilot', model: 'gpt-5-mini' });
    // v1 had no `models.createPr` slot — the migration seeds the new row by falling back to
    // refine's model so post-migration the create-pr AI step has a sane catalog entry.
    expect(ai.createPr).toEqual({ provider: 'github-copilot', model: 'gpt-5-mini' });
  });

  it('post-migration resolveEffort yields the documented matrix', () => {
    const v1 = {
      schemaVersion: 1,
      ai: {
        provider: 'claude-code',
        models: {
          refine: 'claude-sonnet-4-6',
          plan: 'claude-opus-4-7',
          implement: 'claude-opus-4-7',
          readiness: 'claude-sonnet-4-6',
          ideate: 'claude-opus-4-7',
        },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
      developer: { showEvaluatorFailureUI: false },
    };
    const outcome = applyMigrations(v1);
    const parsed = SettingsSchema.safeParse(outcome.value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const settings = parsed.data as Settings;

    // Per-flow rows where the migration seeded an explicit effort: that explicit value wins.
    expect(resolveEffort('implement', settings)).toBe('xhigh');
    expect(resolveEffort('plan', settings)).toBe('xhigh');
    expect(resolveEffort('readiness', settings)).toBe('medium');
    // Rows without an explicit effort fall through to the global default (`high`).
    expect(resolveEffort('refine', settings)).toBe('high');
    expect(resolveEffort('ideate', settings)).toBe('high');
  });

  it('a v2 file is a no-op (migration chain does nothing)', () => {
    const v2 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ai: {
        refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
        plan: { provider: 'claude-code', model: 'claude-opus-4-7' },
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
          evaluator: { provider: 'claude-code', model: 'claude-opus-4-7' },
        },
        readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
        ideate: { provider: 'claude-code', model: 'claude-opus-4-7' },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2 },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
      developer: { showEvaluatorFailureUI: false },
    };
    const outcome = applyMigrations(v2);
    expect(outcome.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(outcome.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.value).toEqual(v2);
  });
});
