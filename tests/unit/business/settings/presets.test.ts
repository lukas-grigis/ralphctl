import { describe, expect, it } from 'vitest';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import { applyPreset, PRESET_NAMES, isPresetName, type PresetName } from '@src/business/settings/presets.ts';

describe('presets', () => {
  it('exposes exactly four equal preset names', () => {
    expect([...PRESET_NAMES]).toEqual(['mixed', 'claude-only', 'copilot-only', 'codex-only']);
  });

  it('isPresetName guards string input', () => {
    expect(isPresetName('mixed')).toBe(true);
    expect(isPresetName('codex-only')).toBe(true);
    expect(isPresetName('not-a-preset')).toBe(false);
  });

  describe('applyPreset', () => {
    const sentinel: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, maxTurns: 9, maxAttempts: 7 },
      logging: { level: 'debug' },
      concurrency: { maxParallelTasks: 3 },
      ui: { notifications: { enabled: false } },
      developer: { showEvaluatorFailureUI: true },
    };

    for (const preset of PRESET_NAMES) {
      it(`'${preset}' stamps a record that round-trips through SettingsSchema`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        const parsed = SettingsSchema.safeParse(out);
        expect(parsed.success).toBe(true);
      });

      it(`'${preset}' preserves harness / logging / concurrency / ui / developer from current`, () => {
        const out = applyPreset(preset, sentinel);
        expect(out.harness).toEqual(sentinel.harness);
        expect(out.logging).toEqual(sentinel.logging);
        expect(out.concurrency).toEqual(sentinel.concurrency);
        expect(out.ui).toEqual(sentinel.ui);
        expect(out.developer).toEqual(sentinel.developer);
        expect(out.schemaVersion).toEqual(sentinel.schemaVersion);
      });

      it(`'${preset}' sets global ai.effort to 'high'`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        expect(out.ai.effort).toBe('high');
      });

      it(`'${preset}' stamps a row for every flow id`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);
        for (const flow of FLOW_IDS) {
          expect(out.ai[flow]).toBeDefined();
          expect(out.ai[flow].provider).toMatch(/^(claude-code|github-copilot|openai-codex)$/);
          expect(out.ai[flow].model.length).toBeGreaterThan(0);
        }
      });
    }

    describe("'mixed' preset matrix", () => {
      const out = applyPreset('mixed', DEFAULT_SETTINGS);

      it('routes refine to openai-codex, plan to github-copilot, implement to claude-code', () => {
        expect(out.ai.refine.provider).toBe('openai-codex');
        expect(out.ai.plan.provider).toBe('github-copilot');
        expect(out.ai.implement.provider).toBe('claude-code');
        expect(out.ai.readiness.provider).toBe('github-copilot');
        expect(out.ai.ideate.provider).toBe('claude-code');
      });

      it('sets implement and plan effort to xhigh, readiness to medium, refine/ideate unset', () => {
        expect(out.ai.implement.effort).toBe('xhigh');
        expect(out.ai.plan.effort).toBe('xhigh');
        expect(out.ai.readiness.effort).toBe('medium');
        expect(out.ai.refine.effort).toBeUndefined();
        expect(out.ai.ideate.effort).toBeUndefined();
      });
    });

    const providerOnlyPresets: ReadonlyArray<[PresetName, AiProvider]> = [
      ['claude-only', 'claude-code'],
      ['copilot-only', 'github-copilot'],
      ['codex-only', 'openai-codex'],
    ];

    for (const [preset, provider] of providerOnlyPresets) {
      describe(`'${preset}' preset`, () => {
        const out = applyPreset(preset, DEFAULT_SETTINGS);

        it(`routes every flow to ${provider}`, () => {
          for (const flow of FLOW_IDS) {
            expect(out.ai[flow].provider).toBe(provider);
          }
        });

        it('matches the effort matrix (implement+plan xhigh / codex high, readiness medium, refine+ideate unset)', () => {
          const heavyEffort = provider === 'openai-codex' ? 'high' : 'xhigh';
          expect(out.ai.implement.effort).toBe(heavyEffort);
          expect(out.ai.plan.effort).toBe(heavyEffort);
          expect(out.ai.readiness.effort).toBe('medium');
          expect(out.ai.refine.effort).toBeUndefined();
          expect(out.ai.ideate.effort).toBeUndefined();
        });
      });
    }

    it('leaves no preset identity behind — a subsequent manual edit sticks', () => {
      const applied = applyPreset('claude-only', DEFAULT_SETTINGS);
      const edited: Settings = {
        ...applied,
        ai: {
          ...applied.ai,
          implement: { ...applied.ai.implement, model: 'claude-haiku-4-5' },
        } as Settings['ai'],
      };
      // Re-parse to confirm no hidden "preset" residue clobbers the edit.
      const parsed = SettingsSchema.safeParse(edited);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ai.implement.model).toBe('claude-haiku-4-5');
      }
    });
  });
});
