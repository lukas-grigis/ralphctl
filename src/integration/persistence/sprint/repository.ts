import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonSprint, toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { listDir, readJson, removeDir, renamePath, writeJsonAtomic } from '@src/integration/io/fs.ts';
import {
  parseIdFromName,
  resolveSprintDir,
  sprintDir,
  sprintFile,
  sprintsDir,
} from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';

export interface FsSprintRepositoryDeps {
  /** Root of the on-disk layout. Per the path resolver, sprints land under `<root>/sprints/`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `SprintRepository`. Each sprint owns its own directory under
 * `<root>/sprints/<id>--<slug>/` containing `sprint.json` (the aggregate this repo manages) plus
 * sibling files maintained by `SprintExecutionRepository` and `TaskRepository`. Removing a
 * sprint via `remove()` deletes the whole directory — execution and task files vanish with it.
 *
 * Reads resolve both the slugged dir and the legacy bare `<id>/` dir via {@link resolveSprintDir}
 * (tolerant reader). `save` reconciles FIRST — atomically renaming any stale `<id>/` or
 * `<id>--<oldSlug>/` dir onto the canonical `<id>--<slug>/` name so the three sub-files move
 * together — THEN writes `sprint.json` into the canonical dir.
 *
 * Listing scans `<root>/sprints/`, treating each subdirectory as one sprint. `SprintId` is
 * UUIDv7, so the canonical lex sort of the leading id (parsed off the `--`) yields chronological
 * order. `findBySlug` is scoped by `ProjectId` because slugs are only unique within their parent
 * project.
 */
/**
 * Bring the on-disk dir for `id` onto its canonical `<id>--<slug>` name BEFORE the sprint.json
 * write, so the existing `execution.json` / `tasks.json` move with it. Renames a legacy `<id>/` or
 * stale `<id>--<oldSlug>/` dir onto the canonical name (atomic, same-fs); when both the canonical
 * and a stale dir somehow coexist, the stale one is removed (the canonical already holds the
 * durable state). Best-effort: any failure is swallowed and the canonical write proceeds — the
 * tolerant reader still resolves whichever dir exists.
 */
const reconcileSprintDir = async (root: AbsolutePath, id: string, canonicalDir: string): Promise<void> => {
  const dir = sprintsDir(root);
  const entries = await listDir(dir);
  if (!entries.ok) return;
  for (const entry of entries.value) {
    const fullPath = join(dir, entry);
    if (fullPath === canonicalDir) continue;
    if (parseIdFromName(entry) !== id) continue;
    // A stale dir for the same id: try to promote it to the canonical name. If the canonical dir
    // already exists, the rename would clobber it — remove the stale dir instead.
    const renamed = await renamePath(fullPath, canonicalDir);
    if (!renamed.ok) await removeDir(fullPath); // best-effort cleanup of the now-redundant stale dir
  }
};

export const createFsSprintRepository = (deps: FsSprintRepositoryDeps): SprintRepository => {
  const list = async (): Promise<Result<readonly Sprint[], StorageError>> => {
    const dir = sprintsDir(deps.root);
    const entries = await listDir(dir);
    if (!entries.ok) return Result.error(entries.error);

    // Sort by the leading id (split on `--`) so chronological UUIDv7 order survives the slug
    // suffix — a `<id>--zzz` dir must still sort by its id, not the whole name.
    const sortedEntries = [...entries.value].sort((a, b) => parseIdFromName(a).localeCompare(parseIdFromName(b)));
    const items: Sprint[] = [];
    for (const entry of sortedEntries) {
      const path = `${dir}/${entry}/sprint.json`;
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) continue; // race or stray dir without sprint.json
        return Result.error(json.error);
      }
      const decoded = decode((input) => fromJsonSprint(input, path), json.value, { entity: 'sprint', path });
      if (!decoded.ok) return Result.error(decoded.error);
      items.push(decoded.value);
    }
    return Result.ok(items);
  };

  return {
    async findById(id) {
      const dir = await resolveSprintDir(deps.root, id);
      if (dir === undefined) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      }
      const path = join(dir, 'sprint.json');
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) {
          return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
        }
        return Result.error(json.error);
      }
      return decode((input) => fromJsonSprint(input, path), json.value, { entity: 'sprint', path });
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
      // Reconcile BEFORE the write so a legacy / old-slug dir (carrying execution.json + tasks.json)
      // is moved onto the canonical name first; sprint.json is then written into the canonical dir.
      const canonicalDir = sprintDir(deps.root, sprint.id, sprint.slug);
      await reconcileSprintDir(deps.root, String(sprint.id), canonicalDir);
      return writeJsonAtomic(sprintFile(deps.root, sprint.id, sprint.slug), toJsonSprint(sprint));
    },

    async remove(id) {
      const dir = await resolveSprintDir(deps.root, id);
      if (dir === undefined) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      }
      const result = await removeDir(dir);
      if (!result.ok && result.error instanceof NotFoundError) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      }
      return result;
    },
  };
};
