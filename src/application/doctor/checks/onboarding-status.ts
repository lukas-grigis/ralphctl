/**
 * `onboardingStatusCheck` — surfaces which projects have unfinished
 * onboarding so the user has a clear "next step" prompt.
 *
 *  - Zero projects → `skip` (a fresh install has nothing to validate).
 *  - All repos onboarded → `pass` with a count summary.
 *  - At least one repo lacks `onboardedAt` → `warn` with details.
 *
 * Onboarding sets `Repository.onboardedAt` (see `markOnboarded`). Missing
 * timestamps mean the user hasn't run `ralphctl project onboard` for that
 * repo, or it was registered before the field existed (legacy JSON).
 */
import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import type { DoctorCheckResult } from '../run-doctor.ts';

export interface OnboardingStatusCheckDeps {
  readonly projectRepo: ProjectRepository;
}

export async function onboardingStatusCheck(deps: OnboardingStatusCheckDeps): Promise<DoctorCheckResult> {
  const listed = await deps.projectRepo.list();
  if (!listed.ok) {
    return {
      name: 'Onboarding status',
      status: 'fail',
      message: `failed to list projects: ${listed.error.message}`,
    };
  }
  const projects = listed.value;
  if (projects.length === 0) {
    return {
      name: 'Onboarding status',
      status: 'skip',
      message: 'no projects registered',
    };
  }

  const issues: string[] = [];
  let total = 0;
  let onboarded = 0;
  for (const project of projects) {
    for (const repo of project.repositories) {
      total++;
      if (repo.onboardedAt !== null) {
        onboarded++;
        continue;
      }
      issues.push(`${String(project.name)}/${repo.name}`);
    }
  }

  if (issues.length === 0) {
    return {
      name: 'Onboarding status',
      status: 'pass',
      message: `${String(onboarded)}/${String(total)} repo${total === 1 ? '' : 's'} onboarded`,
    };
  }

  return {
    name: 'Onboarding status',
    status: 'warn',
    message: `${String(issues.length)} repo${issues.length === 1 ? '' : 's'} not onboarded: ${issues.join(', ')}`,
  };
}
