import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl completion', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('prints a sourceable bash completion script listing the real CLI commands', async () => {
    const result = await runCliCaptured(cli, ['completion', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('complete -F _ralphctl_complete ralphctl');
    // Real one-shot / inspection commands are present …
    for (const command of ['doctor', 'settings', 'completion', 'project', 'sprint', 'ticket', 'task', 'runs']) {
      expect(result.stdout).toContain(command);
    }
  });

  it('omits TUI-only flows that are not CLI commands', async () => {
    const result = await runCliCaptured(cli, ['completion', 'bash']);
    expect(result.exitCode).toBe(0);
    // The completion word list is `local commands="…"`; assert TUI-only flow ids are not in it.
    const line = result.stdout.split('\n').find((l) => l.includes('local commands=')) ?? '';
    const words = line.replace(/.*local commands="|".*/g, '').split(' ');
    for (const flow of ['implement', 'plan', 'refine', 'ideate', 'readiness', 'create-sprint', 'review']) {
      expect(words).not.toContain(flow);
    }
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
