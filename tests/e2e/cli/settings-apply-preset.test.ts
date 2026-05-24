import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '@src/domain/entity/settings.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl settings apply-preset', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('stamps the codex-only matrix and `settings show` confirms it', async () => {
    const apply = await runCliCaptured(cli, ['settings', 'apply-preset', 'codex-only']);
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain('applied preset codex-only');

    const show = await runCliCaptured(cli, ['settings', 'show']);
    expect(show.exitCode).toBe(0);
    const parsed = JSON.parse(show.stdout) as Settings;
    expect(parsed.ai.effort).toBe('high');
    for (const flow of ['refine', 'plan', 'implement', 'readiness', 'ideate'] as const) {
      expect(parsed.ai[flow].provider).toBe('openai-codex');
    }
  });

  it('stamps the mixed preset', async () => {
    const apply = await runCliCaptured(cli, ['settings', 'apply-preset', 'mixed']);
    expect(apply.exitCode).toBe(0);

    const show = await runCliCaptured(cli, ['settings', 'show']);
    const parsed = JSON.parse(show.stdout) as Settings;
    expect(parsed.ai.refine.provider).toBe('openai-codex');
    expect(parsed.ai.plan.provider).toBe('github-copilot');
    expect(parsed.ai.implement.provider).toBe('claude-code');
    expect(parsed.ai.readiness.provider).toBe('github-copilot');
    expect(parsed.ai.ideate.provider).toBe('claude-code');
  });

  it('leaves a subsequent per-key edit intact — no preset identity overwrites it', async () => {
    const apply = await runCliCaptured(cli, ['settings', 'apply-preset', 'claude-only']);
    expect(apply.exitCode).toBe(0);

    const edit = await runCliCaptured(cli, ['settings', 'set', 'ai.implement.model', 'claude-haiku-4-5']);
    expect(edit.exitCode).toBe(0);

    const show = await runCliCaptured(cli, ['settings', 'show']);
    const parsed = JSON.parse(show.stdout) as Settings;
    expect(parsed.ai.implement.model).toBe('claude-haiku-4-5');
    // Other rows still on the claude-only matrix.
    expect(parsed.ai.plan.provider).toBe('claude-code');
  });

  it('exits non-zero on an unknown preset name', async () => {
    const result = await runCliCaptured(cli, ['settings', 'apply-preset', 'banana']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown preset 'banana'");
  });
});
