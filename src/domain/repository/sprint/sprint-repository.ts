import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { FindBySlug } from '@src/domain/repository/_base/find-by-slug.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';

/**
 * Persistence port for the `Sprint` aggregate. Tickets are nested inside the sprint and persist
 * together via `save()` — the aggregate boundary is the unit of persistence (no separate ticket
 * repository).
 *
 * Composed from narrow capabilities. `SprintId` is UUIDv7, so {@link listLatest} gives the N
 * most-recent sprints without a separate `createdAt` field. `findBySlug` is scoped by
 * `ProjectId` because sprint slugs are only unique within their project.
 */
export interface SprintRepository
  extends FindById<Sprint, SprintId>, FindBySlug<Sprint, ProjectId>, ListAll<Sprint>, Save<Sprint>, Remove<SprintId> {}
