import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl skills list', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('lists the bundled catalog with tier + enabled flows on a fresh install', async () => {
    const result = await runCliCaptured(cli, ['skills', 'list']);
    expect(result.exitCode).toBe(0);

    // Descends from v1's global default bundle — default-ON for every flow whose launcher
    // actually mounts skills, createPr included (its view / CLI compose a skill source
    // directly — see `flowMountsSkills`'s doc comment in launcher.ts).
    const alignmentLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-alignment'));
    expect(alignmentLine).toBeDefined();
    expect(alignmentLine).toContain('bundled');
    expect(alignmentLine).toContain('flows: refine, plan, implement, readiness, ideate, createPr');

    // Curated addition scoped to a single phase — proves the column isn't just "every flow".
    const ideationLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-idea-refinement'));
    expect(ideationLine).toBeDefined();
    expect(ideationLine).toContain('flows: ideate');
    expect(ideationLine).not.toContain('flows: refine');
  });

  it('reflects a saved opt-out by dropping that flow from the enabled-flows column', async () => {
    const settingsRepo = createJsonSettingsRepository({ configRoot: cli.paths.configRoot });
    await settingsRepo.save({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, skills: { implement: { disabled: ['ralphctl-alignment'] } } },
    });

    const result = await runCliCaptured(cli, ['skills', 'list']);
    expect(result.exitCode).toBe(0);
    const alignmentLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-alignment'));
    expect(alignmentLine).toBeDefined();
    // "implement" no longer sits between "plan," and "readiness," once opted out — a plain
    // `not.toContain('implement')` would false-positive on unrelated description prose.
    expect(alignmentLine).toContain('flows: refine, plan, readiness, ideate, createPr');
  });
});
