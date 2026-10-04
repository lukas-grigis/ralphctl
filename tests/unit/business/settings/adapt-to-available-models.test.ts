import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, type AiProvider, type AiSettings } from '@src/domain/entity/settings.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { applyPreset, PRESET_NAMES } from '@src/business/settings/presets.ts';
import {
  adaptAiToAvailableModels,
  aiRowKey,
  PRESET_MODEL_FALLBACKS,
} from '@src/business/settings/adapt-to-available-models.ts';

const CATALOG: Readonly<Record<AiProvider, readonly string[]>> = {
  'claude-code': CLAUDE_MODELS,
  'github-copilot': COPILOT_MODELS,
  'openai-codex': CODEX_MODELS,
  'xai-grok': GROK_MODELS,
  opencode: OPENCODE_MODELS,
};

const rows = (ai: AiSettings): ReadonlyArray<{ readonly provider: AiProvider; readonly model: string }> => [
  ai.refine,
  ai.plan,
  ai.implement.generator,
  ai.implement.evaluator,
  ai.readiness,
  ai.ideate,
  ai.createPr,
];

const without = (provider: AiProvider, ...gone: string[]): Map<AiProvider, ReadonlySet<string>> =>
  new Map([[provider, new Set(CATALOG[provider].filter((m) => !gone.includes(m)))]]);

describe('PRESET_MODEL_FALLBACKS', () => {
  it('names only catalog models of the same provider', () => {
    for (const provider of AI_PROVIDERS) {
      for (const [model, standIns] of Object.entries(PRESET_MODEL_FALLBACKS[provider])) {
        expect(CATALOG[provider], `${provider}: ${model}`).toContain(model);
        for (const standIn of standIns)
          expect(CATALOG[provider], `${provider}: ${model} → ${standIn}`).toContain(standIn);
      }
    }
  });

  it('covers every model a preset or provider default stamps — a new preset model needs a stand-in', () => {
    const stamped = [
      ...PRESET_NAMES.flatMap((p) => rows(applyPreset(p, DEFAULT_SETTINGS).ai)),
      ...AI_PROVIDERS.flatMap((p) => rows(defaultAiSettingsForProvider(p))),
    ];
    for (const { provider, model } of stamped) {
      expect(PRESET_MODEL_FALLBACKS[provider][model], `${provider}: ${model}`).toBeDefined();
    }
  });
});

describe('adaptAiToAvailableModels', () => {
  const copilotOnly = applyPreset('copilot-only', DEFAULT_SETTINGS).ai;

  it('moves rows the account cannot run to the nearest stand-in and keeps their effort', () => {
    const out = adaptAiToAvailableModels(copilotOnly, without('github-copilot', 'gpt-6-luna'));
    expect(out.ai.readiness).toEqual({ ...copilotOnly.readiness, model: 'gpt-5.6-luna' });
    expect(out.ai.createPr.model).toBe('gpt-5.6-luna');
    expect(out.substitutions.map(aiRowKey)).toEqual(['ai.readiness', 'ai.createPr']);
    expect(out.substitutions[0]).toMatchObject({ provider: 'github-copilot', from: 'gpt-6-luna', to: 'gpt-5.6-luna' });
    expect(out.unavailable).toEqual([]);
  });

  it('walks the stand-in list in order and labels implement roles', () => {
    const out = adaptAiToAvailableModels(
      copilotOnly,
      without('github-copilot', 'claude-opus-4.8', 'claude-sonnet-5.5')
    );
    expect(out.ai.implement.generator.model).toBe('claude-sonnet-5');
    expect(out.substitutions.map(aiRowKey)).toContain('ai.implement.generator');
  });

  it('keeps the model and reports it when no stand-in is available', () => {
    const out = adaptAiToAvailableModels(copilotOnly, without('github-copilot', 'gpt-6-luna', 'gpt-5.6-luna'));
    expect(out.ai.readiness.model).toBe('gpt-6-luna');
    expect(out.unavailable.map(aiRowKey)).toEqual(['ai.readiness', 'ai.createPr']);
  });

  it('leaves providers the probe did not answer for untouched', () => {
    const out = adaptAiToAvailableModels(copilotOnly, new Map());
    expect(out.ai).toEqual(copilotOnly);
    expect(out.substitutions).toEqual([]);
  });
});
