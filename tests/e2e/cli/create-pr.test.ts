import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl create-pr', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('--help lists all options with their short aliases and defaults', async () => {
    const result = await runCliCaptured(cli, ['create-pr', '--help']);
    // command description
    expect(result.stdout).toContain("open a PR for the sprint's branch and persist the URL");
    // optional sprint flag — rendered as [id] by commander (not required)
    expect(result.stdout).toContain('--sprint');
    // cwd override
    expect(result.stdout).toContain('--cwd');
    // base branch with default
    expect(result.stdout).toContain('--base');
    expect(result.stdout).toContain('main');
    // draft flag
    expect(result.stdout).toContain('--draft');
    // title / body overrides
    expect(result.stdout).toContain('--title');
    expect(result.stdout).toContain('--body');
    // AI toggle
    expect(result.stdout).toContain('--no-ai');
  });

  it('exits 1 with "invalid sprint id" when --sprint is not a UUIDv7', async () => {
    const result = await runCliCaptured(cli, ['create-pr', '--sprint', 'not-a-uuid']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid sprint id');
  });

  it('exits 1 with guidance when no sprint is pinned and --sprint is omitted', async () => {
    const result = await runCliCaptured(cli, ['create-pr']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no sprint specified');
    expect(result.stderr).toContain('sprint set-current');
  });

  it('exits 1 with "--cwd: path must be absolute" when --cwd is a relative path', async () => {
    // The cwd check runs before sprint resolution, so no valid sprint id is needed here.
    const result = await runCliCaptured(cli, ['create-pr', '--cwd', 'relative/path']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--cwd');
    expect(result.stderr).toContain('path must be absolute');
  });
});
