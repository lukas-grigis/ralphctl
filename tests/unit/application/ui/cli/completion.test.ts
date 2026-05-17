import { describe, expect, it } from 'vitest';
import { generateCompletion } from '@src/application/ui/cli/completion.ts';
import { flowRegistry } from '@src/application/registry.ts';

describe('completion script generation', () => {
  it('bash script registers ralphctl and lists every flow id', () => {
    const script = generateCompletion('bash');
    expect(script).toContain('complete -F _ralphctl_complete ralphctl');
    for (const entry of flowRegistry) {
      expect(script).toContain(entry.manifest.id);
    }
  });

  it('bash script includes the CLI-only commands', () => {
    const script = generateCompletion('bash');
    expect(script).toContain('doctor');
    expect(script).toContain('settings');
    expect(script).toContain('completion');
  });

  it('zsh script declares #compdef ralphctl and lists commands', () => {
    const script = generateCompletion('zsh');
    expect(script).toContain('#compdef ralphctl');
    expect(script).toContain('_describe');
    for (const entry of flowRegistry) {
      expect(script).toContain(`'${entry.manifest.id}'`);
    }
  });
});
