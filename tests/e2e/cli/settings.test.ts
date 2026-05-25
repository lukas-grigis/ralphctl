import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

// Hoisted state holder — each test mutates this before running so the mocked
// `detectInstalledProviders` returns a deterministic set regardless of the host's PATH. The
// CLI's `settings set ai.<flow>.provider` path runs the same gate the launch-time fail-fast
// helper uses; mocking here lets us assert blocked-vs-allowed without depending on what's
// installed on whoever is running the suite.
const detectRef = vi.hoisted(() => ({ installed: new Set<AiProvider>() }));

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl settings', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
    // Default to "every provider installed" — individual tests narrow this for gate
    // assertions. Re-seeding here avoids cross-test contamination.
    detectRef.installed = new Set(['claude-code', 'github-copilot', 'openai-codex']);
  });

  afterEach(async () => cli.cleanup());

  describe('show', () => {
    it('prints DEFAULT_SETTINGS as JSON on a fresh install', async () => {
      const result = await runCliCaptured(cli, ['settings', 'show']);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as unknown;
      expect(parsed).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('set', () => {
    it('persists harness.maxTurns and show reflects the new value', async () => {
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '7']);
      expect(setResult.exitCode).toBe(0);
      expect(setResult.stdout).toContain('harness.maxTurns = 7');

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      expect(showResult.exitCode).toBe(0);
      const parsed = JSON.parse(showResult.stdout) as { readonly harness: { readonly maxTurns: number } };
      expect(parsed.harness.maxTurns).toBe(7);
    });

    it('persists logging.level', async () => {
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'logging.level', 'debug']);
      expect(setResult.exitCode).toBe(0);

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as { readonly logging: { readonly level: string } };
      expect(parsed.logging.level).toBe('debug');
    });

    it('persists a per-flow ai.<flow>.model', async () => {
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'ai.plan.model', 'claude-haiku-4-5']);
      expect(setResult.exitCode).toBe(0);

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as {
        readonly ai: { readonly plan: { readonly model: string } };
      };
      expect(parsed.ai.plan.model).toBe('claude-haiku-4-5');
    });

    it('persists a per-role implement effort under ai.implement.<role>.effort', async () => {
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'ai.implement.generator.effort', 'xhigh']);
      expect(setResult.exitCode).toBe(0);

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as {
        readonly ai: { readonly implement: { readonly generator: { readonly effort?: string } } };
      };
      expect(parsed.ai.implement.generator.effort).toBe('xhigh');
    });

    it('exits non-zero with a stderr message for an unknown key', async () => {
      const result = await runCliCaptured(cli, ['settings', 'set', 'foo.bar', 'baz']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown settings key 'foo.bar'");
    });

    it('exits non-zero when the new value would fail schema validation', async () => {
      // maxTurns is bounded 1..10. 99 fails the schema at the persistence boundary.
      const result = await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '99']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });

    it('rejects the v1 ai.provider key with `unknown settings key`', async () => {
      const result = await runCliCaptured(cli, ['settings', 'set', 'ai.provider', 'claude-code']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown settings key 'ai.provider'");
    });

    it('rejects the v1 ai.models.<flow> key with `unknown settings key`', async () => {
      const result = await runCliCaptured(cli, ['settings', 'set', 'ai.models.plan', 'claude-opus-4-7']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown settings key 'ai.models.plan'");
    });

    it('rejects an unknown provider value on ai.<flow>.provider', async () => {
      const result = await runCliCaptured(cli, ['settings', 'set', 'ai.refine.provider', 'not-a-real-provider']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a recognised provider');
    });

    it('persists a per-flow provider via the gated settings-set-provider flow when the CLI is installed', async () => {
      detectRef.installed = new Set(['claude-code', 'github-copilot', 'openai-codex']);
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'ai.refine.provider', 'github-copilot']);
      expect(setResult.exitCode).toBe(0);
      expect(setResult.stdout).toContain('ai.refine.provider = github-copilot');

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as {
        readonly ai: { readonly refine: { readonly provider: string; readonly model: string } };
      };
      expect(parsed.ai.refine.provider).toBe('github-copilot');
      // Model rebuilt from the target provider's defaults — the discriminated-union schema
      // would otherwise reject the save with claude-only models still in the row.
      expect(parsed.ai.refine.model).toContain('gpt');
    });

    it('blocks ai.<flow>.provider when the requested provider CLI is not installed', async () => {
      detectRef.installed = new Set(['claude-code']);
      const result = await runCliCaptured(cli, ['settings', 'set', 'ai.refine.provider', 'openai-codex']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('openai-codex');
      expect(result.stderr).toContain('ai.refine.provider');
      expect(result.stderr).toContain('npm install -g @openai/codex');

      // Persistence must NOT have happened — the disk still shows the default refine row.
      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as {
        readonly ai: { readonly refine: { readonly provider: string } };
      };
      expect(parsed.ai.refine.provider).toBe(DEFAULT_SETTINGS.ai.refine.provider);
    });

    it('blocks ai.implement.<role>.provider when the requested provider CLI is not installed', async () => {
      detectRef.installed = new Set(['claude-code']);
      const result = await runCliCaptured(cli, [
        'settings',
        'set',
        'ai.implement.evaluator.provider',
        'github-copilot',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('github-copilot');
      expect(result.stderr).toContain('ai.implement.evaluator.provider');
      expect(result.stderr).toContain('gh extension install github/gh-copilot');
    });
  });
});
