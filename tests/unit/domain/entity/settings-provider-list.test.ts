import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, AI_PROVIDERS_HINT, type AiProvider } from '@src/domain/entity/settings.ts';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { parseImplementRoleOverrides } from '@src/application/ui/cli/parse-implement-role-overrides.ts';
import { AI_PROVIDERS as SETTINGS_VIEW_PROVIDERS } from '@src/application/ui/tui/views/settings-view-model.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

/**
 * Liveness suite for the runtime provider list.
 *
 * The `AiProvider` union is a COMPILE-time construct, so `Record<AiProvider, …>` exhaustiveness
 * cannot see a hand-written `['claude-code', 'github-copilot', 'openai-codex']` — such an array
 * still type-checks as `readonly AiProvider[]` after a fourth provider joins. That is exactly how
 * shipping OpenCode left `settings set ai.<flow>.provider opencode`, the CLI implement-role
 * overrides, and both provider pickers rejecting it while the whole suite stayed green.
 *
 * These tests assert the behaviour a user would notice — every provider is settable and offered —
 * for EVERY member of the union, so the next provider added cannot repeat it.
 */
describe('AI_PROVIDERS is the single runtime source', () => {
  it('covers every provider that has a traits row', () => {
    // PROVIDER_TRAITS is `Record<AiProvider, …>`, so its keys ARE the union at runtime.
    expect([...AI_PROVIDERS].sort()).toEqual(Object.keys(PROVIDER_TRAITS).sort());
  });

  it('lists more than the three original providers', () => {
    // Guards against someone re-hardcoding the old trio while the union has grown.
    expect(AI_PROVIDERS.length).toBeGreaterThanOrEqual(4);
    expect(AI_PROVIDERS).toContain('opencode');
    expect(AI_PROVIDERS).toContain('xai-grok');
  });

  it('renders a hint naming every provider', () => {
    for (const provider of AI_PROVIDERS) expect(AI_PROVIDERS_HINT).toContain(provider);
  });
});

describe('every provider is settable and offered', () => {
  it.each([...AI_PROVIDERS])('applySettingsKey accepts %s on a flow row', (provider: AiProvider) => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.plan.provider', provider);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ai.plan.provider).toBe(provider);
  });

  it.each([...AI_PROVIDERS])('the CLI implement-role override accepts %s', (provider: AiProvider) => {
    const parsed = parseImplementRoleOverrides({
      generatorProvider: provider,
      generatorModel: 'some-model-id',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.overrides?.generator?.provider).toBe(provider);
  });

  it('the TUI settings view offers every provider', () => {
    expect([...SETTINGS_VIEW_PROVIDERS].sort()).toEqual([...AI_PROVIDERS].sort());
  });
});
