import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl completion', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('prints a sourceable bash completion script', async () => {
    const result = await runCliCaptured(cli, ['completion', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('complete -F _ralphctl_complete ralphctl');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('settings');
    expect(result.stdout).toContain('completion');
  });

  it('prints a sourceable zsh completion script', async () => {
    const result = await runCliCaptured(cli, ['completion', 'zsh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#compdef ralphctl');
    expect(result.stdout).toContain('_describe');
  });

  it('exits 1 with a stderr message for an unsupported shell', async () => {
    const result = await runCliCaptured(cli, ['completion', 'fish']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported shell');
  });
});
