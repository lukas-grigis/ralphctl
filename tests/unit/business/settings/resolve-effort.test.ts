import { describe, expect, it } from 'vitest';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyPreset } from '@src/business/settings/presets.ts';
import { clampEffortToProvider, resolveEffort } from '@src/business/settings/resolve-effort.ts';

const withGlobalEffort = (effort: Settings['ai']['effort']): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: { ...DEFAULT_SETTINGS.ai, ...(effort !== undefined ? { effort } : {}) },
});

const withPerFlowEffort = (flow: 'refine' | 'plan' | 'readiness' | 'ideate', effort: string): Settings => ({
  ...DEFAULT_SETTINGS,
  ai: {
    ...DEFAULT_SETTINGS.ai,
    [flow]: { ...DEFAULT_SETTINGS.ai[flow], effort },
  } as Settings['ai'],
});

describe('resolveEffort', () => {
  it('resolves plan and ideate to the shipped high default when neither the row nor the global effort is set', () => {
    expect(resolveEffort('plan', DEFAULT_SETTINGS)).toBe('high');
    expect(resolveEffort('ideate', DEFAULT_SETTINGS)).toBe('high');
  });

  it('leaves every other flow resolving to undefined when neither the row nor the global effort is set', () => {
    expect(resolveEffort('refine', DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveEffort('readiness', DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveEffort('createPr', DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveEffort('implement', DEFAULT_SETTINGS)).toBeUndefined();
  });

  it('an explicit global effort wins over the new plan/ideate flow default', () => {
    expect(resolveEffort('plan', withGlobalEffort('low'))).toBe('low');
    expect(resolveEffort('ideate', withGlobalEffort('medium'))).toBe('medium');
  });

  it('an explicit per-flow row effort wins over the new plan/ideate flow default', () => {
    expect(resolveEffort('plan', withPerFlowEffort('plan', 'low'))).toBe('low');
    expect(resolveEffort('ideate', withPerFlowEffort('ideate', 'medium'))).toBe('medium');
  });

  it('returns the per-flow value when set, ignoring the global', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        effort: 'medium',
        plan: { ...DEFAULT_SETTINGS.ai.plan, effort: 'max' },
      } as Settings['ai'],
    };
    expect(resolveEffort('plan', settings)).toBe('max');
    // Implement reads from the generator row — DEFAULT_SETTINGS.implement.generator has no
    // explicit effort, so the global 'medium' surfaces. Codex evaluator's effort is read
    // separately at the spawn site and is not the concern of resolveEffort.
    expect(resolveEffort('implement', settings)).toBe('medium');
  });

  it('falls through to global effort when the per-flow row omits it', () => {
    expect(resolveEffort('refine', withGlobalEffort('high'))).toBe('high');
  });

  it('passes a global xhigh through unclamped for codex (xhigh is now universal across the catalog)', () => {
    // Set every row to codex so `resolveEffort` always sees the codex floor table.
    const codexEverywhere: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        effort: 'xhigh',
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        plan: { provider: 'openai-codex', model: 'gpt-5.5' },
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
        },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
        createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      },
    };
    expect(resolveEffort('implement', codexEverywhere)).toBe('xhigh');
    expect(resolveEffort('readiness', { ...codexEverywhere, ai: { ...codexEverywhere.ai, effort: 'medium' } })).toBe(
      'medium'
    );
  });

  it('floors a global max to xhigh for codex — only the 5.6 family accepts max, and this clamp has no model context', () => {
    const codexEverywhere: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        effort: 'max',
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        plan: { provider: 'openai-codex', model: 'gpt-5.5' },
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.5' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
        },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
        createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      },
    };
    expect(resolveEffort('implement', codexEverywhere)).toBe('xhigh');
    expect(resolveEffort('plan', codexEverywhere)).toBe('xhigh');
  });

  it('passes a global effort through identity for claude-code rows', () => {
    expect(resolveEffort('implement', withGlobalEffort('xhigh'))).toBe('xhigh');
  });

  it('per-flow effort wins even when global would be floored', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        effort: 'max',
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' },
        plan: { provider: 'openai-codex', model: 'gpt-5.5' },
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
        },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
        createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
      },
    };
    expect(resolveEffort('refine', settings)).toBe('low');
    expect(resolveEffort('plan', settings)).toBe('xhigh'); // floored from max
  });

  it('returns the per-flow value verbatim for the configured provider', () => {
    expect(resolveEffort('plan', withPerFlowEffort('plan', 'low'))).toBe('low');
  });

  it('never stamps the plan/ideate flow default on an opencode row — the CLI picks the upstream default', () => {
    // OpenCode aggregates upstream providers, so `--variant high` may be rejected outright by the
    // row's model. The opencode-only preset documents effort as deliberately unset on every row.
    const opencodeOnly = applyPreset('opencode-only', DEFAULT_SETTINGS);
    expect(resolveEffort('plan', opencodeOnly)).toBeUndefined();
    expect(resolveEffort('ideate', opencodeOnly)).toBeUndefined();
  });

  it('an explicit per-row effort still reaches an opencode row verbatim', () => {
    const opencodeOnly = applyPreset('opencode-only', DEFAULT_SETTINGS);
    const withRowEffort: Settings = {
      ...opencodeOnly,
      ai: { ...opencodeOnly.ai, plan: { ...opencodeOnly.ai.plan, effort: 'high' } } as Settings['ai'],
    };
    expect(resolveEffort('plan', withRowEffort)).toBe('high');
  });

  it('an explicit global ai.effort still reaches an opencode row', () => {
    const opencodeOnly = applyPreset('opencode-only', DEFAULT_SETTINGS);
    const withGlobal: Settings = { ...opencodeOnly, ai: { ...opencodeOnly.ai, effort: 'medium' } };
    expect(resolveEffort('plan', withGlobal)).toBe('medium');
    expect(resolveEffort('refine', withGlobal)).toBe('medium');
  });
});

describe('clampEffortToProvider', () => {
  it('passes xhigh through unclamped for codex but floors max to xhigh', () => {
    expect(clampEffortToProvider('xhigh', 'openai-codex')).toBe('xhigh');
    expect(clampEffortToProvider('max', 'openai-codex')).toBe('xhigh');
  });

  it('passes ultra through unclamped for codex — plan-gated, explicit-only, the CLI is the final arbiter', () => {
    expect(clampEffortToProvider('ultra', 'openai-codex')).toBe('ultra');
  });

  it('passes effort through unchanged for claude-code and github-copilot', () => {
    expect(clampEffortToProvider('xhigh', 'claude-code')).toBe('xhigh');
    expect(clampEffortToProvider('max', 'github-copilot')).toBe('max');
  });

  it('passes effort through unchanged for xai-grok — including max, which Codex floors', () => {
    expect(clampEffortToProvider('xhigh', 'xai-grok')).toBe('xhigh');
    expect(clampEffortToProvider('max', 'xai-grok')).toBe('max');
    expect(clampEffortToProvider('none', 'xai-grok')).toBe('none');
  });

  it('passes an unknown effort string through unchanged for every provider', () => {
    expect(clampEffortToProvider('ultra-mega', 'openai-codex')).toBe('ultra-mega');
    expect(clampEffortToProvider('ultra-mega', 'claude-code')).toBe('ultra-mega');
  });
});
