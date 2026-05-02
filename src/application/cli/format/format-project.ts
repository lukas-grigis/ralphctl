/**
 * Plain-text formatters for project-shaped output. Pure — no I/O.
 */
import * as c from 'colorette';

import type { Project } from '@src/domain/entities/project.ts';
import type { Repository } from '@src/domain/entities/repository.ts';

function onboardedSummary(project: Project): string {
  const total = project.repositories.length;
  if (total === 0) return '';
  const onboarded = project.repositories.filter((r) => r.onboardedAt !== null).length;
  if (total === 1) {
    return onboarded === 1 ? c.green('onboarded') : c.dim('not onboarded');
  }
  const text = `${String(onboarded)}/${String(total)} onboarded`;
  return onboarded === total ? c.green(text) : c.dim(text);
}

function repoOnboardedSuffix(repo: Repository): string {
  if (repo.onboardedAt !== null) {
    const date = repo.onboardedAt.slice(0, 10);
    return c.green(`onboarded ${date}`);
  }
  return c.dim('not onboarded');
}

export function formatProjectLine(project: Project): string {
  const name = c.bold(project.name);
  const display = c.dim(project.displayName);
  const repos = c.dim(`${String(project.repositories.length)} repo(s)`);
  const onboarded = onboardedSummary(project);
  return `  ${name}  ${display}  ${repos}  ${onboarded}`;
}

export function formatProjectCard(project: Project): string {
  const lines: string[] = [];
  lines.push(c.bold(project.displayName));
  lines.push(`  ${c.dim('name       ')} ${project.name}`);
  if (project.description) {
    lines.push(`  ${c.dim('description')} ${project.description}`);
  }
  lines.push(`  ${c.dim('repositories')}`);
  for (const repo of project.repositories) {
    lines.push(`    - ${c.bold(repo.name)} ${c.dim(repo.path)}  ${repoOnboardedSuffix(repo)}`);
    if (repo.checkScript) {
      lines.push(`      ${c.dim('check:')} ${repo.checkScript}`);
    }
    if (repo.checkTimeout !== undefined) {
      lines.push(`      ${c.dim('timeout:')} ${String(repo.checkTimeout)} ms`);
    }
  }
  return lines.join('\n');
}
