import { describe, expect, it } from 'vitest';
import { generateCompletion } from '@src/application/ui/cli/completion.ts';

const COMMANDS = ['sprint', 'project', 'doctor', 'completion'];

describe('completion script generation', () => {
  it('bash script registers ralphctl and lists the supplied commands', () => {
    const script = generateCompletion('bash', COMMANDS);
    expect(script).toContain('complete -F _ralphctl_complete ralphctl');
    for (const command of COMMANDS) expect(script).toContain(command);
  });

  it('sorts and de-duplicates the supplied commands', () => {
    const script = generateCompletion('bash', ['zsync', 'alpha', 'alpha', 'beta']);
    expect(script).toContain('local commands="alpha beta zsync"');
  });

  it('zsh script declares #compdef ralphctl and lists the supplied commands', () => {
    const script = generateCompletion('zsh', COMMANDS);
    expect(script).toContain('#compdef ralphctl');
    expect(script).toContain('_describe');
    for (const command of COMMANDS) expect(script).toContain(`'${command}'`);
  });
});
