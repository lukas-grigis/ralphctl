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

  it('implement: when both generator and evaluator providers are missing, surfaces BOTH in a single message', async () => {
    // Cross-provider implement: generator on claude-code, evaluator on openai-codex; neither
    // binary is installed. The probe must name both rows + settings keys so the operator sees
    // the full picture in one shot rather than bailing on the first missing provider.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
        },
      },
    };
    const result = await checkCli('implement', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('claude');
    expect(result.reason).toContain('codex');
    expect(result.reason).toContain('ai.implement.generator.provider');
    expect(result.reason).toContain('ai.implement.evaluator.provider');
    expect(result.reason).toContain('generator');
    expect(result.reason).toContain('evaluator');
  });

  it('implement: when only evaluator provider is missing, surfaces the evaluator role without the generator', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
          evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
        },
      },
    };
    const result = await checkCli('implement', settings, { detect: detectFor(['claude-code']) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toContain('codex');
    expect(result.reason).toContain('evaluator');
    expect(result.reason).toContain('ai.implement.evaluator.provider');
    expect(result.reason).not.toContain('ai.implement.generator.provider');
  });

  it('includes an install command and a docs URL in the failure reason', async () => {
    // Operators reading the launch-time banner shouldn't have to guess how to install the
    // missing CLI — the message names a one-shot command for the operator's OS plus a link
    // to the vendor's setup docs.
    const settings = withFlowProvider('refine', 'openai-codex');
    const result = await checkCli('refine', settings, { detect: detectFor([]) });
    expect(result).toBeDefined();
    if (result === undefined || result.ok) return;
    expect(result.reason).toMatch(/install with: \S/);
    expect(result.reason).toContain('https://github.com/openai/codex');
  });

  it('install-guidance coverage spans every provider', async () => {
    // Probe each provider in isolation so changes to the install guidance table cause the
    // test to fail loudly rather than slipping past one-by-one assertions. Asserts on the
    // vendor's setup docs URL (OS-invariant) rather than a per-OS command.
    const cases = [
      { provider: 'claude-code' as const, docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup' },
      {
        provider: 'github-copilot' as const,
        docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-in-the-cli',
      },
      { provider: 'openai-codex' as const, docsUrl: 'https://github.com/openai/codex' },
    ];
    for (const { provider, docsUrl } of cases) {
      const settings = withFlowProvider('refine', provider);
      const result = await checkCli('refine', settings, { detect: detectFor([]) });
      expect(result).toBeDefined();
      if (result === undefined || result.ok) continue;
      expect(result.reason).toMatch(/install with: \S/);
      expect(result.reason).toContain(docsUrl);
    }
  });
});
