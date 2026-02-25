import type { Command } from 'commander';

/**
 * Check for shell completion environment variables and handle the completion request.
 * Returns `true` if a completion was handled (caller should exit), `false` otherwise.
 *
 * This runs BEFORE banner/interactive mode — must not produce any extra output.
 */
export async function handleCompletionRequest(program: Command): Promise<boolean> {
  const env = process.env;

  // tabtab sets these env vars when the shell triggers completion
  if (!env['COMP_CWORD'] || !env['COMP_POINT'] || !env['COMP_LINE']) {
    return false;
  }

  const tabtab = (await import('tabtab')).default;
  const { resolveCompletions } = await import('@src/completion/resolver.ts');

  const tabEnv = tabtab.parseEnv(env);

  const completions = await resolveCompletions(program, {
    line: tabEnv.line,
    last: tabEnv.last,
    prev: tabEnv.prev,
  });

  tabtab.log(completions);
  return true;
}
