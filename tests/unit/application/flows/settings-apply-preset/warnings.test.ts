import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';

const repoFor = (initial: Settings): { repo: SettingsRepository; saved: { value?: Settings } } => {
  const state: { current: Settings } = { current: initial };
  const saved: { value?: Settings } = {};
  const repo: SettingsRepository = {
    path: '/tmp/settings.json',
    async exists() {
      return Result.ok(true);
    },
    async load() {
      return Result.ok(state.current);
    },
    async save(next) {
      state.current = next;
      saved.value = next;
      return Result.ok(undefined);
    },
  };
  return { repo, saved };
};

const detectFor = (installed: readonly AiProvider[]) => async (): Promise<ReadonlySet<AiProvider>> =>
  new Set(installed);

describe('settings-apply-preset — warnings', () => {
  it('stamps the preset and returns an empty warning list when every provider is installed', async () => {
    const { repo, saved } = repoFor(DEFAULT_SETTINGS);
    const flow = createSettingsApplyPresetFlow({
      settingsRepo: repo,
      detectInstalledProviders: detectFor(['claude-code', 'github-copilot', 'openai-codex']),
    });
    const result = await flow.execute({ input: { preset: 'mixed' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.warnings).toEqual([]);
    expect(saved.value).toBeDefined();
  });

  it('applying mixed without codex warns about codex naming the refine + createPr flows', async () => {
    const { repo } = repoFor(DEFAULT_SETTINGS);
    const flow = createSettingsApplyPresetFlow({
      settingsRepo: repo,
      detectInstalledProviders: detectFor(['claude-code', 'github-copilot']),
    });
    const result = await flow.execute({ input: { preset: 'mixed' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.value.ctx.output!.warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.provider).toBe('openai-codex');
    // mixed routes both refine and createPr to codex (createPr mirrors refine's "light
    // summary" reasoning profile). The grouped warning lists both.
    expect(warnings[0]!.flows).toEqual(['refine', 'createPr']);
  });

  it('groups missing flows under one warning per provider', async () => {
    const { repo } = repoFor(DEFAULT_SETTINGS);
    const flow = createSettingsApplyPresetFlow({
      settingsRepo: repo,
      // Nothing installed — every provider stamped by `mixed` should produce a warning, each
      // grouping its affected flows (preserving FLOW_IDS order: refine, plan, implement, …).
      detectInstalledProviders: detectFor([]),
    });
    const result = await flow.execute({ input: { preset: 'mixed' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.value.ctx.output!.warnings;
    const codex = warnings.find((w) => w.provider === 'openai-codex');
    const copilot = warnings.find((w) => w.provider === 'github-copilot');
    const claude = warnings.find((w) => w.provider === 'claude-code');
    expect(codex?.flows).toEqual(['refine', 'createPr']);
    expect(copilot?.flows).toEqual(['plan', 'readiness']);
    expect(claude?.flows).toEqual(['implement', 'ideate']);
  });

  it('persistence succeeds even when warnings are produced', async () => {
    const { repo, saved } = repoFor(DEFAULT_SETTINGS);
    const flow = createSettingsApplyPresetFlow({
      settingsRepo: repo,
      detectInstalledProviders: detectFor([]),
    });
    const result = await flow.execute({ input: { preset: 'claude-only' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.warnings).toHaveLength(1);
    expect(saved.value).toBeDefined();
    expect(saved.value!.ai.implement.generator.provider).toBe('claude-code');
  });
});
