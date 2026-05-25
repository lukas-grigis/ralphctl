import { describe, expect, it } from 'vitest';
import type { Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';

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
  it('returns undefined when neither per-flow nor global effort is set', () => {
    expect(resolveEffort('refine', DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveEffort('plan', DEFAULT_SETTINGS)).toBeUndefined();
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

  it('floors a global effort to the codex provider ceiling (xhigh / max → high)', () => {
    // Set every row to codex so `resolveEffort` always sees the codex floor table.
    const codexEverywhere: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        effort: 'xhigh',
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        plan: { provider: 'openai-codex', model: 'gpt-5.5' },
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
      },
    };
    expect(resolveEffort('implement', codexEverywhere)).toBe('high');
    expect(resolveEffort('plan', { ...codexEverywhere, ai: { ...codexEverywhere.ai, effort: 'max' } })).toBe('high');
    expect(resolveEffort('readiness', { ...codexEverywhere, ai: { ...codexEverywhere.ai, effort: 'medium' } })).toBe(
      'medium'
    );
  });

  it('passes a global effort through identity for claude-code rows', () => {
    expect(resolveEffort('implement', withGlobalEffort('xhigh'))).toBe('xhigh');
  });

  it('per-flow effort wins even when global would be floored', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        effort: 'xhigh',
        refine: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
        plan: { provider: 'openai-codex', model: 'gpt-5.5' },
        implement: {
          generator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        },
        readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
      },
    };
    expect(resolveEffort('refine', settings)).toBe('minimal');
    expect(resolveEffort('plan', settings)).toBe('high'); // floored from xhigh
  });

  it('returns the per-flow value verbatim for the configured provider', () => {
    expect(resolveEffort('plan', withPerFlowEffort('plan', 'low'))).toBe('low');
  });
});
