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
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

interface PersistedFlowRow {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

interface PersistedSettings {
  readonly schemaVersion?: number;
  readonly ai: {
    readonly effort?: string;
    readonly refine: PersistedFlowRow;
    readonly plan: PersistedFlowRow;
    readonly implement: {
      readonly generator: PersistedFlowRow;
      readonly evaluator: PersistedFlowRow;
    };
    readonly readiness: PersistedFlowRow;
    readonly ideate: PersistedFlowRow;
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
    expect(persisted.ai.implement.generator.provider).toBeTruthy();
    expect(persisted.ai.implement.generator.model).toBeTruthy();
    expect(persisted.ai.implement.evaluator.provider).toBeTruthy();
    expect(persisted.ai.implement.evaluator.model).toBeTruthy();
  });

  it('persists a per-flow ai.<flow>.model to disk', async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');

    const r = await runCliCaptured(cli, ['settings', 'set', 'ai.plan.model', 'claude-haiku-4-5']);
    expect(r.exitCode).toBe(0);

    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as PersistedSettings;
    expect(persisted.ai.plan.model).toBe('claude-haiku-4-5');
  });

  it('persists a per-role implement effort to disk', async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');

    const r = await runCliCaptured(cli, ['settings', 'set', 'ai.implement.generator.effort', 'xhigh']);
    expect(r.exitCode).toBe(0);

    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as PersistedSettings;
    expect(persisted.ai.implement.generator.effort).toBe('xhigh');
  });

  it('rejects the legacy ai.provider key without corrupting the on-disk file', async () => {
    const settingsPath = join(String(cli.paths.configRoot), 'settings.json');
    // Seed with a valid write first so the file exists.
    await runCliCaptured(cli, ['settings', 'set', 'harness.maxTurns', '5']);
    const before = await fs.readFile(settingsPath, 'utf8');

    const r = await runCliCaptured(cli, ['settings', 'set', 'ai.provider', 'github-copilot']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown settings key 'ai.provider'");

    const after = await fs.readFile(settingsPath, 'utf8');
    expect(after).toBe(before);
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
