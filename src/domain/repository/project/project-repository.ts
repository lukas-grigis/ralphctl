import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { FindBySlug } from '@src/domain/repository/_base/find-by-slug.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';

/**
 * Persistence port for the `Project` aggregate. Repositories (the nested entity) are persisted
 * inside the project — mutations go through the project value and `save()`.
 *
 * Composed from narrow capabilities so use cases that only read can depend on the subset they
 * actually need (e.g. `FindById<Project, ProjectId>`) instead of the whole port.
 *
 * Identity is `ProjectId` (UUIDv7). `findById` returns `NotFoundError` when unknown.
 * `findBySlug` is a CLI convenience: project slugs are globally unique.
 */
export interface ProjectRepository
  extends FindById<Project, ProjectId>, FindBySlug<Project>, ListAll<Project>, Save<Project>, Remove<ProjectId> {}
