import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl export-context', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('advertises --project as optional, defaulting to the sprint project', async () => {
    const result = await runCliCaptured(cli, ['export-context', '--help']);
    // commander renders optional options with [..], required with <..>. The help text describes
    // the default-to-sprint behavior.
    expect(result.stdout).toContain("defaults to the sprint's project");
    expect(result.stdout).not.toMatch(/--project <id>\s+project id\n/);
  });

  it('rejects a malformed --project id with the shared UUIDv7 validator message', async () => {
    const result = await runCliCaptured(cli, [
      'export-context',
      '--project',
      'not-a-uuid',
      '--output',
      '/tmp/ralphctl-export-context-test.md',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid project id');
    expect(result.stderr).toContain('UUIDv7');
  });
});
