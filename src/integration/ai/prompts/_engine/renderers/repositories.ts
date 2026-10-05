import type { Project } from '@src/domain/entity/project.ts';
import { normalizeVerifyGates } from '@src/business/task/run-verify-script.ts';

/**
 * Markdown bullet list of a project's repositories for the plan / ideate prompts. Each repository
 * lists its verify gates as sub-bullets so the planner can tell what the harness already runs after
 * every task; a repository with no gate gets no line. Gates come from `normalizeVerifyGates`, so
 * precedence (`verifyGates` over a legacy `verifyScript`) matches the executor.
 */
export const renderRepositoriesSection = (project: Project): string => {
  if (project.repositories.length === 0) return '_no repositories configured_';
  const lines: string[] = [];
  for (const repo of project.repositories) {
    lines.push(`- \`${String(repo.path)}\` (${repo.name})`);
    for (const gate of normalizeVerifyGates(repo.verifyScript, repo.verifyGates)) {
      const command = gate.command.replace(/\s+/g, ' ').trim();
      const scope =
        gate.pathPrefix === '' ? '' : ` (path: \`${gate.pathPrefix}\` — runs only when the task's diff touches it)`;
      lines.push(`  - verify gate: \`${command}\`${scope}`);
    }
  }
  return lines.join('\n');
};
