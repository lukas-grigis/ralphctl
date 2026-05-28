import { randomUUID } from 'node:crypto';
import type { Result } from '@src/domain/result.ts';
import {
  type ApprovedTicket,
  approveTicketRequirements,
  createTicket,
  type PendingTicket,
} from '@src/domain/entity/ticket.ts';
import {
  activateSprint,
  type ActiveSprint,
  createSprintWithExecution,
  type DoneSprint,
  type DraftSprint,
  type PlannedSprint,
  planSprint,
  type ReviewSprint,
  transitionSprintToDone,
  transitionSprintToReview,
} from '@src/domain/entity/sprint.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createProject, type Project } from '@src/domain/entity/project.ts';
import { createRepository, type Repository } from '@src/domain/entity/repository.ts';
import type { DoneTask, InProgressTask, TodoTask } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { recordRunningAttemptVerification, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { markTaskDone } from '@src/domain/entity/task-settle.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { CommitSha } from '@src/domain/value/commit-sha.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) {
    const err: unknown = r.error;
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    throw new Error(`fixture unwrap failed: ${msg}`);
  }
  return r.value as T;
};

export const slug = (s: string): Slug => unwrap(Slug.parse(s));
export const projectId = (s: string): ProjectId => unwrap(ProjectId.parse(s));
export const repositoryId = (s: string): RepositoryId => unwrap(RepositoryId.parse(s));
export const absolutePath = (s: string): AbsolutePath => unwrap(AbsolutePath.parse(s));
export const isoTimestamp = (s: string): IsoTimestamp => unwrap(IsoTimestamp.parse(s));
export const commitSha = (s: string): CommitSha => unwrap(CommitSha.parse(s));

export const FIXED_NOW = isoTimestamp('2026-05-08T10:00:00.000Z');
export const FIXED_LATER = isoTimestamp('2026-05-08T11:00:00.000Z');
export const FIXED_LATEST = isoTimestamp('2026-05-08T12:00:00.000Z');

/** Stable UUIDv7s for tests that need deterministic equality across runs. */
export const FIXED_PROJECT_ID = projectId('01900000-0000-7000-8000-000000000001');
export const FIXED_REPOSITORY_ID = repositoryId('01900000-0000-7000-8000-000000000002');

/**
 * Per-process repo path for the default fixture. Randomised at module load so a stale
 * `/tmp/ralph/main-repo` left behind by a real ralphctl session (or another test run)
 * cannot influence probes that stat repo paths.
 */
export const FIXTURE_REPO_PATH = `/tmp/ralph/${randomUUID()}/main-repo`;

export const makeRepository = (
  overrides: Partial<{ id: RepositoryId; slug: string; name: string; path: string }> = {}
): Repository =>
  unwrap(
    createRepository({
      id: overrides.id ?? FIXED_REPOSITORY_ID,
      ...(overrides.slug !== undefined ? { slug: slug(overrides.slug) } : {}),
      path: absolutePath(overrides.path ?? FIXTURE_REPO_PATH),
      name: overrides.name ?? 'main-repo',
    })
  );

export const makeProject = (
  overrides: Partial<{ id: ProjectId; slug: string; displayName: string; repositories: Repository[] }> = {}
): Project =>
  unwrap(
    createProject({
      id: overrides.id ?? FIXED_PROJECT_ID,
      ...(overrides.slug !== undefined ? { slug: slug(overrides.slug) } : {}),
      displayName: overrides.displayName ?? 'Demo Project',
      description: 'fixture project',
      repositories: overrides.repositories ?? [makeRepository()],
    })
  );

export const makePendingTicket = (overrides: Partial<{ title: string; externalRef: string }> = {}): PendingTicket =>
  unwrap(
    createTicket({
      title: overrides.title ?? 'a ticket',
      ...(overrides.externalRef !== undefined ? { externalRef: overrides.externalRef } : {}),
    })
  );

export const makeApprovedTicket = (
  overrides: Partial<{ title: string; requirements: string; externalRef: string }> = {}
): ApprovedTicket =>
  unwrap(
    approveTicketRequirements(
      makePendingTicket({
        ...(overrides.title !== undefined ? { title: overrides.title } : {}),
        ...(overrides.externalRef !== undefined ? { externalRef: overrides.externalRef } : {}),
      }),
      overrides.requirements ?? 'do the thing well'
    )
  );

export interface SprintBundle {
  readonly sprint: DraftSprint;
  readonly execution: SprintExecution;
}

export const makeDraftSprintBundle = (
  overrides: Partial<{ name: string; projectId: ProjectId; slug: string }> = {}
): SprintBundle =>
  unwrap(
    createSprintWithExecution({
      name: overrides.name ?? 'sprint-1',
      ...(overrides.slug !== undefined ? { slug: slug(overrides.slug) } : {}),
      projectId: overrides.projectId ?? FIXED_PROJECT_ID,
    })
  );

export const makeDraftSprint = (
  overrides: Partial<{ tickets: ApprovedTicket[]; name: string; projectId: ProjectId; slug: string }> = {}
): DraftSprint => {
  const bundle = makeDraftSprintBundle({
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    ...(overrides.slug !== undefined ? { slug: overrides.slug } : {}),
  });
  if (overrides.tickets !== undefined) {
    return { ...bundle.sprint, tickets: overrides.tickets };
  }
  return bundle.sprint;
};

export const makePlannedSprint = (overrides?: { tickets?: ApprovedTicket[] }): PlannedSprint => {
  const draft = makeDraftSprint({ tickets: overrides?.tickets ?? [makeApprovedTicket()] });
  return unwrap(planSprint(draft, FIXED_LATER));
};

export const makeActiveSprint = (overrides?: { tickets?: ApprovedTicket[] }): ActiveSprint =>
  unwrap(activateSprint(makePlannedSprint(overrides), FIXED_LATEST));

export const makeReviewSprint = (overrides?: { tickets?: ApprovedTicket[] }): ReviewSprint =>
  unwrap(transitionSprintToReview(makeActiveSprint(overrides), FIXED_LATEST));

export const makeDoneSprint = (): DoneSprint => unwrap(transitionSprintToDone(makeReviewSprint(), FIXED_LATEST));

export const makeExecution = (sprintId: SprintBundle['execution']['sprintId']): SprintExecution =>
  createSprintExecution({ sprintId });

export const makeTodoTask = (
  overrides: Partial<{
    name: string;
    order: number;
    ticketId: TicketId;
    repositoryId: RepositoryId;
    dependsOn: TaskId[];
    maxAttempts: number;
    externalRefs: readonly string[];
  }> = {}
): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: overrides.name ?? 'do-the-work',
      order: overrides.order ?? 1,
      ticketId: overrides.ticketId ?? ticket.id,
      repositoryId: overrides.repositoryId ?? FIXED_REPOSITORY_ID,
      steps: ['step 1'],
      verificationCriteria: [{ id: 'C1', assertion: 'runs to completion', check: 'manual' }],
      ...(overrides.dependsOn !== undefined ? { dependsOn: overrides.dependsOn } : {}),
      ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
      ...(overrides.externalRefs !== undefined ? { externalRefs: overrides.externalRefs } : {}),
    })
  );
};

export const makeInProgressTaskWithRunningAttempt = (overrides?: { maxAttempts?: number }): InProgressTask => {
  const todo = makeTodoTask(overrides?.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {});
  return unwrap(startNextAttempt(todo, FIXED_NOW, 'session-1'));
};

export const makeDoneTask = (overrides?: { name?: string; externalRefs?: readonly string[] }): DoneTask => {
  const todoOverrides: Parameters<typeof makeTodoTask>[0] = {};
  if (overrides?.name !== undefined) todoOverrides.name = overrides.name;
  if (overrides?.externalRefs !== undefined) todoOverrides.externalRefs = overrides.externalRefs;
  const todo = makeTodoTask(todoOverrides);
  const inProgress = unwrap(startNextAttempt(todo, FIXED_NOW, 'session-1'));
  const verified = unwrap(recordRunningAttemptVerification(inProgress));
  return unwrap(markTaskDone(verified, FIXED_LATER));
};
