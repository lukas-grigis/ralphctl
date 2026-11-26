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

    // Default-ON in two flows — proves the column lists every enabled flow.
    const ponytailLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-ponytail'));
    expect(ponytailLine).toBeDefined();
    expect(ponytailLine).toContain('bundled');
    expect(ponytailLine).toContain('flows: plan, implement');

    // Scoped to a single phase — proves the column isn't just "every flow".
    const ideationLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-idea-refinement'));
    expect(ideationLine).toBeDefined();
    expect(ideationLine).toContain('flows: ideate');
    expect(ideationLine).not.toContain('flows: refine');
  });

  it('reflects a saved opt-out by dropping that flow from the enabled-flows column', async () => {
    const settingsRepo = createJsonSettingsRepository({ configRoot: cli.paths.configRoot });
    await settingsRepo.save({
      ...DEFAULT_SETTINGS,
      // A retired bundled name in the saved row must not break the listing.
      ai: { ...DEFAULT_SETTINGS.ai, skills: { implement: { disabled: ['ralphctl-ponytail', 'ralphctl-alignment'] } } },
    });

    const result = await runCliCaptured(cli, ['skills', 'list']);
    expect(result.exitCode).toBe(0);
    const ponytailLine = result.stdout.split('\n').find((line) => line.startsWith('ralphctl-ponytail'));
    expect(ponytailLine).toBeDefined();
    // A plain `not.toContain('implement')` would false-positive on unrelated description prose.
    expect(ponytailLine).toContain('flows: plan');
    expect(ponytailLine).not.toContain('flows: plan, implement');
  });
});
