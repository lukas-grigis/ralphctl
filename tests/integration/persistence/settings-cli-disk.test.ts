/**
 * `ralphctl settings set <key> <value>` disk round-trip. Verifies that mutating a setting via
 * the CLI lands in `<configRoot>/settings.json` with the right shape — the load chain re-reads
 * the saved file and applies it without error.
 *
 * What a regression here catches:
 *  - Settings persistence schema change without migration → `settings.json` parse fails
 *  - SettingsRepository#save writes to the wrong path or wrong shape
 *  - apply-key business rule lets through invalid values (the load then rejects them)
 *
 * Uses the real CLI harness (`runCliCaptured`) — same process the user actually runs.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

interface PersistedSettings {
  readonly schemaVersion?: number;
  readonly ai: {
    readonly provider: string;
    readonly models: Record<string, string>;
  };
  readonly harness: {
    readonly maxTurns: number;
    readonly maxAttempts: number;
    readonly rateLimitRetries: number;
  };
}

describe('ralphctl settings set — disk round-trip', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => {
    await cli.cleanup();
  });

  it('writes a scalar setting (harness.maxTurns) to settings.json on disk', async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');

    // Sanity: settings.json doesn't exist yet (fresh home).
    const existsBefore = await fs
      .stat(settingsPath)
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(false);

    const r = await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '7']);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);

    const raw = await fs.readFile(settingsPath, 'utf8');
    const persisted = JSON.parse(raw) as PersistedSettings;

    expect(persisted.harness.maxTurns).toBe(7);
    // Other settings still at defaults — set-one-key must not zero out the rest.
    expect(persisted.harness.maxAttempts).toBeGreaterThan(0);
    expect(persisted.ai.provider).toBeTruthy();
  });

  it("switching provider rewrites models to the new provider's defaults", async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');

    // First land an explicit non-default value so we can prove the provider switch resets it.
    await runCliCaptured(cli, ['settings', 'set', 'ai.provider', 'claude-code']);
    const afterClaude = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as PersistedSettings;
    expect(afterClaude.ai.provider).toBe('claude-code');
    const claudeModels = afterClaude.ai.models;
    expect(Object.keys(claudeModels).length).toBeGreaterThan(0);

    // Switch to copilot — models should reset to copilot defaults.
    const r = await runCliCaptured(cli, ['settings', 'set', 'ai.provider', 'github-copilot']);
    expect(r.exitCode).toBe(0);

    const afterCopilot = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as PersistedSettings;
    expect(afterCopilot.ai.provider).toBe('github-copilot');
    // Models reset — at least one model string changed.
    const sameModels = Object.entries(claudeModels).every(([key, val]) => afterCopilot.ai.models[key] === val);
    expect(sameModels, 'expected at least one model to change after provider switch').toBe(false);
  });

  it('invalid value is rejected: settings.json on disk is unchanged', async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');
    // Seed with a known-good value first.
    await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '5']);
    const before = await fs.readFile(settingsPath, 'utf8');

    // Out-of-range write — must fail without corrupting the on-disk file.
    const r = await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '999']);
    expect(r.exitCode).not.toBe(0);

    const after = await fs.readFile(settingsPath, 'utf8');
    expect(after).toBe(before);
  });
});
