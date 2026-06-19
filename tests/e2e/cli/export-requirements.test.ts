import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl export-requirements', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('--help describes the command and shows --output as required and --sprint as optional', async () => {
    const result = await runCliCaptured(cli, ['export-requirements', '--help']);
    // command description
    expect(result.stdout).toContain("write the sprint's approved-ticket requirements to a markdown file");
    // required output path — commander renders required options with <..>
    expect(result.stdout).toContain('--output');
    // optional sprint flag
    expect(result.stdout).toContain('--sprint');
  });

  it('exits non-zero when --output is not supplied (required option)', async () => {
    // commander enforces requiredOption before the action fires.
    const result = await runCliCaptured(cli, ['export-requirements']);
    expect(result.exitCode).not.toBe(0);
    // commander emits "required option '-o, --output <path>' not specified"
    expect(result.stderr).toContain('--output');
  });

  it('exits 1 with "--output: path must be absolute" when --output is a relative path', async () => {
    // The output-path check runs before sprint resolution, so no pin is needed.
    const result = await runCliCaptured(cli, ['export-requirements', '--output', 'relative/path.md']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--output');
    expect(result.stderr).toContain('path must be absolute');
  });

  it('exits 1 with "invalid sprint id" when --sprint is not a UUIDv7', async () => {
    const result = await runCliCaptured(cli, [
      'export-requirements',
      '--sprint',
      'not-a-uuid',
      '--output',
      '/tmp/ralphctl-export-requirements-test.md',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid sprint id');
  });

  it('exits 1 with guidance when no sprint is pinned and --sprint is omitted', async () => {
    const result = await runCliCaptured(cli, [
      'export-requirements',
      '--output',
      '/tmp/ralphctl-export-requirements-test.md',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no sprint specified');
    expect(result.stderr).toContain('sprint set-current');
  });
});
