import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RALPHCTL_HOME_ENV } from '@src/application/bootstrap/storage-paths.ts';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { type CliHome, createCliHome } from '@tests/e2e/cli/_harness.ts';

/**
 * Bare `ralphctl` bootstraps before the Ink mount; a corrupt settings.json must surface the same
 * repair hint the CLI shows, not just the parse fault.
 */
describe('launchTui with an invalid settings.json', () => {
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;
  const originalExitCode = process.exitCode;
  const originalHome = process.env[RALPHCTL_HOME_ENV];
  let cli: CliHome;
  let stderr: string;

  beforeEach(async () => {
    cli = await createCliHome();
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.env[RALPHCTL_HOME_ENV] = String(cli.home);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
    process.exitCode = originalExitCode;
    if (originalHome === undefined) delete process.env[RALPHCTL_HOME_ENV];
    else process.env[RALPHCTL_HOME_ENV] = originalHome;
    await cli.cleanup();
  });

  it.each([
    ['not valid JSON', '{ "ai":'],
    ['schema-invalid', JSON.stringify({ schemaVersion: 1, ai: { provider: 12345 } })],
  ])('prints the repair hint and exits non-zero without mounting (%s)', async (_kind, body) => {
    await fs.writeFile(join(String(cli.paths.configRoot), 'settings.json'), body, 'utf8');

    await launchTui();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('failed to start TUI — settings: ');
    expect(stderr).toContain('fix or delete settings.json');
  });
});
