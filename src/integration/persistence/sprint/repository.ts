import { Result } from '@src/domain/result.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonSprint, toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { listDir, readJson, removeDir, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { sprintDir, sprintFile, sprintsDir } from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';

export interface FsSprintRepositoryDeps {
  /** Root of the on-disk layout. Per the path resolver, sprints land under `<root>/sprints/`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `SprintRepository`. Each sprint owns its own directory under
 * `<root>/sprints/<sprint-id>/` containing `sprint.json` (the aggregate this repo manages) plus
 * sibling files maintained by `SprintExecutionRepository` and `TaskRepository`. Removing a
 * sprint via `remove()` deletes the whole directory — execution and task files vanish with it.
 *
 * Listing scans `<root>/sprints/`, treating each subdirectory as one sprint. `SprintId` is
 * UUIDv7, so the canonical lex sort of directory names yields chronological order — use
 * {@link listLatest} for the N most-recent. `findBySlug` is scoped by `ProjectId` because slugs
 * are only unique within their parent project.
 */
export const createFsSprintRepository = (deps: FsSprintRepositoryDeps): SprintRepository => {
  const list = async (): Promise<Result<readonly Sprint[], StorageError>> => {
    const dir = sprintsDir(deps.root);
    const entries = await listDir(dir);
    if (!entries.ok) return Result.error(entries.error);

    const sortedIds = [...entries.value].sort();
    const items: Sprint[] = [];
    for (const id of sortedIds) {
      const path = `${dir}/${id}/sprint.json`;
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) continue; // race or stray dir without sprint.json
        return Result.error(json.error);
      }
      const decoded = decode(fromJsonSprint, json.value, { entity: 'sprint', path });
      if (!decoded.ok) return Result.error(decoded.error);
      items.push(decoded.value);
    }
    return Result.ok(items);
  };

  return {
    async findById(id) {
      const path = sprintFile(deps.root, id);
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) {
          return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
        }
        return Result.error(json.error);
      }
      return decode(fromJsonSprint, json.value, { entity: 'sprint', path });
    },

    async findBySlug(slug, projectId: ProjectId) {
      const all = await list();
      if (!all.ok) return Result.error(all.error);
      const match = all.value.find((s) => s.slug === slug && s.projectId === projectId);
      if (match === undefined) {
        return Result.error(
          new NotFoundError({
            entity: 'sprint',
            id: `${String(projectId)}:${String(slug)}`,
            message: `sprint with slug '${String(slug)}' not found in project '${String(projectId)}'`,
          })
        );
      }
      return Result.ok(match);
    },

    list,

    async save(sprint) {
      return writeJsonAtomic(sprintFile(deps.root, sprint.id), toJsonSprint(sprint));
    },

    async remove(id) {
      const result = await removeDir(sprintDir(deps.root, id));
      if (!result.ok && result.error instanceof NotFoundError) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      }
      return result;
    },
  };
};
