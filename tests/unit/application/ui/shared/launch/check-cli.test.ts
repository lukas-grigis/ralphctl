import { describe, expect, it } from 'vitest';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS, defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

const detectFor = (installed: readonly AiProvider[]) => async (): Promise<ReadonlySet<AiProvider>> =>
  new Set(installed);

/**
 * Replace one per-flow row by deriving from `defaultAiSettingsForProvider`. Reusing the
 * defaults helper keeps the discriminated-union row type narrow without forcing the test to
 * construct a literal that mirrors the schema's discriminator.
 */
const withFlowProvider = (flow: 'refine' | 'implement' | 'readiness', provider: AiProvider): Settings => {
  const fresh = defaultAiSettingsForProvider(provider);
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, [flow]: fresh[flow] },
  };
};

describe('checkCli', () => {
  it('returns undefined when the configured provider is on PATH', async () => {
    const result = await checkCli('implement', DEFAULT_SETTINGS, {
      detect: detectFor(['claude-code', 'github-copilot', 'openai-codex']),
    });
    expect(result).toBeUndefined();
  });

  it('aborts implement with a message naming the missing binary, the flow, and the settings key', async () => {
    const settings = withFlowProvider('implement', 'claude-code');
    const result = await checkCli('implement', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('claude');
    expect(result.reason).toContain('implement');
    expect(result.reason).toContain('ai.implement.generator.provider');
  });

  it('maps detect-scripts and detect-skills to the readiness row', async () => {
    const settings = withFlowProvider('readiness', 'openai-codex');
    const result = await checkCli('detect-scripts', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('codex');
    expect(result.reason).toContain('readiness');
    expect(result.reason).toContain('ai.readiness.provider');
  });

  it('maps review to the implement row', async () => {
    const settings = withFlowProvider('implement', 'openai-codex');
    const result = await checkCli('review', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('codex');
    expect(result.reason).toContain('implement');
    expect(result.reason).toContain('ai.implement.generator.provider');
  });

  it('returns undefined for non-AI flows', async () => {
    const result = await checkCli('create-sprint', DEFAULT_SETTINGS, { detect: detectFor([]) });
    expect(result).toBeUndefined();
  });

  it('names gh as the missing binary for github-copilot', async () => {
    const settings = withFlowProvider('refine', 'github-copilot');
    const result = await checkCli('refine', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('CLI gh not on PATH');
    expect(result.reason).toContain('refine');
  });
});
