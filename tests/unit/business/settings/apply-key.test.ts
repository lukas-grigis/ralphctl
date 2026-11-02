import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { AI_PROVIDERS, type AiProvider, type Settings } from '@src/domain/entity/settings.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
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
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.plan.effort', 'xhigh');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.plan.effort).toBe('xhigh');
  });

  it('clears a per-flow effort when given an empty string', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.plan.effort', 'xhigh');
    const seededValue = seeded.getOrThrow();
    const cleared = applySettingsKey(seededValue, 'ai.plan.effort', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.ai.plan.effort).toBeUndefined();
  });

  it('updates the per-role implement model under ai.implement.generator.model', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.generator.model', 'claude-haiku-4-5');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ai.implement.generator.model).toBe('claude-haiku-4-5');
      // Evaluator left untouched — per-role keys edit one role at a time.
      expect(result.value.ai.implement.evaluator.model).toBe(DEFAULT_SETTINGS.ai.implement.evaluator.model);
    }
  });

  it('updates the per-role implement effort under ai.implement.evaluator.effort', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.evaluator.effort', 'high');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.implement.evaluator.effort).toBe('high');
  });

  it('rejects the legacy flat ai.implement.<field> with a role-prefixed hint', () => {
    for (const field of ['provider', 'model', 'effort'] as const) {
      const result = applySettingsKey(DEFAULT_SETTINGS, `ai.implement.${field}`, 'whatever');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('implement splits into generator and evaluator');
        expect(result.error.hint).toContain(`ai.implement.generator.${field}`);
        expect(result.error.hint).toContain(`ai.implement.evaluator.${field}`);
      }
    }
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
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.models.plan', 'claude-opus-4-8');
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

  it.each([
    ['harness.bestOfNCandidates', ''],
    ['harness.maxTurns', '   '],
    ['harness.rateLimitRetries', ''],
    ['concurrency.maxParallelTasks', ' '],
  ])('rejects an empty value for %s instead of storing 0', (key, raw) => {
    const result = applySettingsKey(DEFAULT_SETTINGS, key, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('needs a number');
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

  it('rejects the removed scm.postRefinementComment key as unknown', () => {
    const r = applySettingsKey(DEFAULT_SETTINGS, 'scm.postRefinementComment', 'true');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('unknown settings key');
  });

  it('binds an agent-definition name to the evaluator role under ai.implement.agents.evaluator', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.agents.evaluator', 'ralphctl-evaluator');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ai.implement.agents?.evaluator).toBe('ralphctl-evaluator');
      // Generator left untouched — per-role keys edit one role at a time.
      expect(result.value.ai.implement.agents?.generator).toBeUndefined();
    }
  });

  it('binds an agent-definition name to the generator role under ai.implement.agents.generator', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.agents.generator', 'ralphctl-generator');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.implement.agents?.generator).toBe('ralphctl-generator');
  });

  it('clears an agent-definition binding when given an empty string', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.agents.evaluator', 'ralphctl-evaluator');
    const seededValue = seeded.getOrThrow();
    const cleared = applySettingsKey(seededValue, 'ai.implement.agents.evaluator', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.ai.implement.agents?.evaluator).toBeUndefined();
  });

  it('drops the whole agents block once every role binding is cleared', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.agents.evaluator', 'ralphctl-evaluator');
    const seededValue = seeded.getOrThrow();
    const cleared = applySettingsKey(seededValue, 'ai.implement.agents.evaluator', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.ai.implement.agents).toBeUndefined();
  });

  it('rejects binding an agent definition to a flow other than implement', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.refine.agents.evaluator', 'ralphctl-evaluator');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('not supported for agent-definition binding in this release');
      expect(result.error.hint).toContain('ai.implement.agents.{generator,evaluator}');
    }
  });

  it('rejects binding an agent definition to an implement role other than generator/evaluator', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.agents.reviewer', 'ralphctl-evaluator');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('not supported for agent-definition binding in this release');
    }
  });
});

describe("applySettingsKey — values the row's provider does not accept", () => {
  const onProvider = (provider: AiProvider): Settings => ({
    ...DEFAULT_SETTINGS,
    ai: defaultAiSettingsForProvider(provider),
  });

  it.each([
    ['xai-grok', 'ai.refine.effort', 'none'],
    ['xai-grok', 'ai.refine.effort', 'minimal'],
    ['xai-grok', 'ai.implement.generator.effort', 'none'],
    ['xai-grok', 'ai.refine.effort', 'bogus'],
    ['openai-codex', 'ai.plan.effort', 'minimal'],
    ['openai-codex', 'ai.implement.evaluator.effort', 'minimal'],
    ['claude-code', 'ai.plan.effort', 'none'],
  ] as const)('refuses %s effort %s=%s and names the accepted levels', (provider, key, value) => {
    const result = applySettingsKey(onProvider(provider), key, value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.field).toBe(key);
    expect(result.error.message).toContain(provider);
    expect(result.error.hint).toBe(`expected one of: ${PROVIDER_EFFORT_LEVELS[provider].join(', ')}`);
  });

  it('accepts every level the provider lists, trimmed', () => {
    for (const provider of AI_PROVIDERS) {
      for (const level of PROVIDER_EFFORT_LEVELS[provider]) {
        const result = applySettingsKey(onProvider(provider), 'ai.refine.effort', ` ${level} `);
        expect(result.ok && result.value.ai.refine.effort).toBe(level);
      }
    }
  });

  it('refuses a retired model id and names its successor', () => {
    const result = applySettingsKey(onProvider('claude-code'), 'ai.plan.model', 'claude-opus-4-7');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.field).toBe('ai.plan.model');
    expect(result.error.hint).toContain('claude-opus-4-8');
  });

  it('keeps a slug retired on another backend when the row still lists it', () => {
    const result = applySettingsKey(onProvider('xai-grok'), 'ai.plan.model', 'grok-4.5');
    expect(result.ok && result.value.ai.plan.model).toBe('grok-4.5');
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
