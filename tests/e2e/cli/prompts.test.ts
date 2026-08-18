import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';
import {
  BUNDLED_PROMPT_PARTIALS,
  BUNDLED_PROMPT_TEMPLATES,
} from '@src/integration/ai/prompts/_engine/bundled-templates.ts';

describe('ralphctl prompts list', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('loads every bundled template + partial through the real resolver', async () => {
    const result = await runCliCaptured(cli, ['prompts', 'list']);

    expect(result.exitCode).toBe(0);
    for (const name of [...BUNDLED_PROMPT_TEMPLATES, ...BUNDLED_PROMPT_PARTIALS]) {
      expect(result.stdout).toContain(name);
    }
    // One row per asset — the command loads each body, it does not just echo the inventory.
    const rows = result.stdout.trimEnd().split('\n');
    expect(rows).toHaveLength(BUNDLED_PROMPT_TEMPLATES.length + BUNDLED_PROMPT_PARTIALS.length);
    for (const row of rows) expect(row).toMatch(/\s+\d+ bytes$/);
  });

  it('prints the flow name the dist smokes grep for at the start of a line', async () => {
    const result = await runCliCaptured(cli, ['prompts', 'list']);

    // `.github/workflows/{ci,release}.yml` assert `grep -q '^implement'` against this output.
    expect(result.stdout).toMatch(/^implement\s/m);
  });
});
