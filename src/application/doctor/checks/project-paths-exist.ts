/**
 * `projectPathsExistCheck` — confirms every registered repository points
 * at a real directory containing a `.git` entry.
 *
 *  - Zero projects → `skip` (a fresh install has nothing to validate).
 *  - All paths valid → `pass` with a count summary.
 *  - One or more paths missing or non-git → `fail` with details.
 *
 * Each repo is checked independently so we surface every problem in one
 * pass instead of fail-fast.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import type { DoctorCheckResult } from '../run-doctor.ts';

export interface ProjectPathsExistCheckDeps {
  readonly projectRepo: ProjectRepository;
}

async function isGitDir(path: string): Promise<boolean> {
  try {
    const s = await stat(join(path, '.git'));
    // `.git` may be a directory (normal repo) or a file (submodule /
    // worktree). Both qualify.
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function projectPathsExistCheck(deps: ProjectPathsExistCheckDeps): Promise<DoctorCheckResult> {
  const listed = await deps.projectRepo.list();
  if (!listed.ok) {
    return {
      name: 'Project paths',
      status: 'fail',
      message: `failed to list projects: ${listed.error.message}`,
    };
  }
  const projects = listed.value;
  if (projects.length === 0) {
    return {
      name: 'Project paths',
      status: 'skip',
      message: 'no projects registered',
    };
  }

  const issues: string[] = [];
  let repoCount = 0;
  for (const project of projects) {
    for (const repo of project.repositories) {
      repoCount++;
      const dir = await isDirectory(repo.path);
      if (!dir) {
        issues.push(`${project.name}/${repo.name}: path missing or not a directory`);
        continue;
      }
      if (!(await isGitDir(repo.path))) {
        issues.push(`${project.name}/${repo.name}: not a git repository`);
      }
    }
  }

  if (issues.length === 0) {
    return {
      name: 'Project paths',
      status: 'pass',
      message: `${String(repoCount)} repo${repoCount === 1 ? '' : 's'} verified`,
    };
  }

  return {
    name: 'Project paths',
    status: 'fail',
    message: issues.join('; '),
  };
}
