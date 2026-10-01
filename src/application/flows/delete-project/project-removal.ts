import { Result } from '@src/domain/result.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { deleteProjectUseCase } from '@src/business/project/delete-project.ts';
import { deleteSprintUseCase } from '@src/business/sprint/delete-sprint.ts';
import type { DeleteProjectDeps } from '@src/application/flows/delete-project/deps.ts';

export interface ProjectRemovalSprint {
  readonly id: SprintId;
  readonly name: string;
  readonly status: SprintStatus;
  readonly ticketCount: number;
}

/** What a cascading removal would delete beside the project file itself. */
export interface ProjectRemovalPreview {
  readonly sprints: readonly ProjectRemovalSprint[];
  readonly memoryDirs: number;
  readonly bytes: number;
}

export interface ProjectRemovalReport {
  readonly removedSprints: number;
  readonly removedMemoryDirs: number;
}

/** Project removal with an opt-in cascade. */
export interface ProjectRemoval {
  preview(projectId: ProjectId): Promise<Result<ProjectRemovalPreview, StorageError>>;
  remove(
    projectId: ProjectId,
    opts: { readonly cascade: boolean }
  ): Promise<Result<ProjectRemovalReport, NotFoundError | StorageError>>;
}

const listOwnedSprints = async (
  deps: DeleteProjectDeps,
  projectId: ProjectId
): Promise<Result<readonly ProjectRemovalSprint[], StorageError>> => {
  const all = await deps.sprintRepo.list();
  if (!all.ok) return Result.error(all.error);
  return Result.ok(
    all.value
      .filter((s) => s.projectId === projectId)
      .map((s) => ({ id: s.id, name: s.name, status: s.status, ticketCount: s.tickets.length }))
  );
};

const removeChildren = async (
  deps: DeleteProjectDeps,
  projectId: ProjectId
): Promise<Result<ProjectRemovalReport, StorageError>> => {
  const sprints = await listOwnedSprints(deps, projectId);
  if (!sprints.ok) return Result.error(sprints.error);
  let removedSprints = 0;
  for (const sprint of sprints.value) {
    const r = await deleteSprintUseCase({ id: sprint.id, sprintRepo: deps.sprintRepo, logger: deps.logger });
    if (r.ok) removedSprints += 1;
    else if (!(r.error instanceof NotFoundError)) return Result.error(r.error);
  }
  const memory = await deps.housekeepingDisk.removeMemoryDirs(projectId);
  if (!memory.ok) return Result.error(memory.error);
  return Result.ok({ removedSprints, removedMemoryDirs: memory.value });
};

export const createProjectRemoval = (deps: DeleteProjectDeps): ProjectRemoval => ({
  async preview(projectId) {
    const sprints = await listOwnedSprints(deps, projectId);
    if (!sprints.ok) return Result.error(sprints.error);
    const memory = await deps.housekeepingDisk.listMemoryDirs();
    if (!memory.ok) return Result.error(memory.error);
    const ownMemory = memory.value.filter((m) => m.projectId === projectId);
    let bytes = ownMemory.reduce((acc, m) => acc + m.bytes, 0);
    for (const sprint of sprints.value) bytes += await deps.housekeepingDisk.sprintBytes(sprint.id);
    return Result.ok({ sprints: sprints.value, memoryDirs: ownMemory.length, bytes });
  },

  async remove(projectId, opts) {
    const exists = await deps.projectRepo.findById(projectId);
    if (!exists.ok) return Result.error(exists.error);
    let report: ProjectRemovalReport = { removedSprints: 0, removedMemoryDirs: 0 };
    if (opts.cascade) {
      const children = await removeChildren(deps, projectId);
      if (!children.ok) return Result.error(children.error);
      report = children.value;
    }
    const removed = await deleteProjectUseCase({ id: projectId, projectRepo: deps.projectRepo, logger: deps.logger });
    if (!removed.ok) return Result.error(removed.error);
    return Result.ok(report);
  },
});
