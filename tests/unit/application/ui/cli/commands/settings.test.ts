import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

// Hoisted state holder — each test seeds this so the mocked `detectInstalledProviders`
// returns a deterministic set regardless of the host's PATH. A provider switch on the CLI
// runs the same gate the launch-time fail-fast helper uses; mocking here lets us assert
// allowed-vs-blocked without depending on what's installed on whoever runs the suite.
const detectRef = vi.hoisted(() => ({ installed: new Set<AiProvider>() }));

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

// Regression cover for audit M2: switching `ai.createPr.provider` must route through the
// gated `settings-set-provider` flow (model rebuilt from the target provider's defaults +
// PATH-availability gate), NOT fall through to the generic apply-key setter — which would
// leave a stale/incoherent model and bypass the PATH check.
describe('ralphctl settings set ai.createPr.provider — routes through settings-set-provider', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
    detectRef.installed = new Set(['claude-code', 'github-copilot', 'openai-codex']);
  });

  afterEach(async () => cli.cleanup());

  it('rebuilds the createPr model from the target provider defaults when the CLI is installed', async () => {
    // Default createPr provider is claude-code (claude-sonnet-4-6). Switching to
    // github-copilot must rebuild the model from copilot's defaults (a gpt-* id) — the
    // generic setter would leave the claude model in place and the discriminated-union
    // schema would reject the save.
    const setResult = await runCliCaptured(cli, ['settings', 'set', 'ai.createPr.provider', 'github-copilot']);
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toContain('ai.createPr.provider = github-copilot');

    const showResult = await runCliCaptured(cli, ['settings', 'show']);
    expect(showResult.exitCode).toBe(0);
    const parsed = JSON.parse(showResult.stdout) as {
      readonly ai: { readonly createPr: { readonly provider: string; readonly model: string } };
    };
    expect(parsed.ai.createPr.provider).toBe('github-copilot');
    // Model rebuilt from the target provider's defaults (a gpt-* id), not left at the
    // claude default — proves the set-provider flow ran, not the generic setter.
    expect(parsed.ai.createPr.model).toContain('gpt');
    expect(parsed.ai.createPr.model).not.toBe(DEFAULT_SETTINGS.ai.createPr.model);
  });

  it('fires the PATH-availability gate when the requested createPr provider CLI is not installed', async () => {
    detectRef.installed = new Set(['claude-code']);
    const result = await runCliCaptured(cli, ['settings', 'set', 'ai.createPr.provider', 'openai-codex']);
    // The generic setter has no PATH gate — a non-zero exit naming the binary proves the
    // gated set-provider flow ran instead.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('openai-codex');
    expect(result.stderr).toContain('ai.createPr.provider');
    expect(result.stderr).toContain('npm install -g @openai/codex');

    // Persistence must NOT have happened — the gate fires BEFORE the write.
    const showResult = await runCliCaptured(cli, ['settings', 'show']);
    const parsed = JSON.parse(showResult.stdout) as {
      readonly ai: { readonly createPr: { readonly provider: string } };
    };
    expect(parsed.ai.createPr.provider).toBe(DEFAULT_SETTINGS.ai.createPr.provider);
  });
});
