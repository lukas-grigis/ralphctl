import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl settings', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
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

    it('persists a per-flow ai.<flow>.effort', async () => {
      const setResult = await runCliCaptured(cli, ['settings', 'set', 'ai.implement.effort', 'xhigh']);
      expect(setResult.exitCode).toBe(0);

      const showResult = await runCliCaptured(cli, ['settings', 'show']);
      const parsed = JSON.parse(showResult.stdout) as {
        readonly ai: { readonly implement: { readonly effort?: string } };
      };
      expect(parsed.ai.implement.effort).toBe('xhigh');
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
  });
});
