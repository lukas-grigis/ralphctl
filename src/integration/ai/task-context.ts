import { execSync } from 'node:child_process';
import { Result } from 'typescript-result';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';

/**
 * Get recent git history for a project path. Consumed by `ExternalPort.getRecentGitHistory`
 * and embedded into the per-task context file so the agent can see what was
 * committed recently without running `git log` itself.
 *
 * Returns a best-effort string: if the path isn't a git repo or `git log` fails,
 * the caller still gets a recognisable marker rather than an exception.
 */
export function getRecentGitHistory(projectPath: string, count = 20): string {
  const r = Result.try(() => {
    assertSafeCwd(projectPath);
    const result = execSync(`git log -${String(count)} --oneline --no-decorate`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  });
  return r.ok ? r.value : '(Unable to retrieve git history)';
}
