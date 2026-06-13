import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl unknown command handling', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('rejects an unknown verb with a helpful message and exit 1 (not "too many arguments")', async () => {
    const result = await runCliCaptured(cli, ['nonexistent-command']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'nonexistent-command'");
    expect(result.stderr).toContain("run 'ralphctl --help'");
    expect(result.stderr).not.toContain('too many arguments');
  });

  it('teaches the TUI-primary design when the verb names an interactive flow', async () => {
    const result = await runCliCaptured(cli, ['implement']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'implement'");
    expect(result.stderr).toContain('interactive flow');
    expect(result.stderr).toContain("bare 'ralphctl'");
  });
});
