/**
 * `handleCompletionRequest` — early intercept for tabtab's completion env.
 *
 * Tabtab sets `COMP_CWORD`, `COMP_POINT`, `COMP_LINE` in the environment when
 * the user's shell triggers completion. We detect those, resolve a candidate
 * list, log it via `tabtab.log`, and tell the caller to exit. This must run
 * before any banner / TUI mount path so the shell sees only the completion
 * output.
 */
import type { Command } from 'commander';

import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { resolveCompletions } from './resolver.ts';

/**
 * Check for shell completion environment variables and handle the request.
 * Returns `true` if a completion was handled (caller should exit), `false`
 * otherwise.
 */
export async function handleCompletionRequest(program: Command, deps: SharedDeps): Promise<boolean> {
  const env = process.env;
  if (env['COMP_CWORD'] === undefined || env['COMP_POINT'] === undefined || env['COMP_LINE'] === undefined) {
    return false;
  }

  const tabtab = (await import('tabtab')).default;
  const tabEnv = tabtab.parseEnv(env);

  const completions = await resolveCompletions(
    program,
    {
      line: tabEnv.line,
      last: tabEnv.last,
      prev: tabEnv.prev,
    },
    deps
  );

  tabtab.log([...completions]);
  return true;
}
