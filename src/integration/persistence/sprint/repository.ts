import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonSprint, toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import {
  listDir,
  pathExists,
  readJson,
  removeDir,
  removeEmptyDir,
  renamePath,
  writeJsonAtomic,
} from '@src/integration/io/fs.ts';
import {
  parseIdFromName,
  resolveSprintDir,
  sprintDir,
  sprintFile,
  sprintsDir,
} from '@src/integration/persistence/storage.ts';
import { decodeDeduped, readEntity } from '@src/integration/persistence/shared/read-entities.ts';

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
 * (tolerant reader). `save` first brings any other dir for the id onto the canonical `<id>--<slug>/`
 * name via {@link ensureCanonicalSprintDir}, THEN writes `sprint.json` into it.
 *
 * Listing scans `<root>/sprints/`, treating each subdirectory as one sprint. `SprintId` is
 * UUIDv7, so the canonical lex sort of the leading id (parsed off the `--`) yields chronological
 * order. `findBySlug` is scoped by `ProjectId` because slugs are only unique within their parent
 * project.
 */

/**
 * `<id>::<canonicalDir>` keys whose scan found no stale sibling with the canonical dir present — later saves in this
 * process skip the O(N_sprints) rescan.
 */
const reconciledDirs = new Set<string>();

/** Move each entry the canonical dir lacks out of `staleDir`; a clashing entry stays put, so `rmdir` keeps the dir. */
const mergeIntoCanonical = async (staleDir: string, canonicalDir: string): Promise<void> => {
  const children = await listDir(staleDir);
  if (!children.ok) return;
  for (const child of children.value) {
    const target = join(canonicalDir, child);
    const taken = await pathExists(target);
    if (!taken.ok || taken.value) continue;
    await renamePath(join(staleDir, child), target);
  }
  await removeEmptyDir(staleDir);
};

/**
 * Bring every other dir for `id` (the legacy bare `<id>/` or a leftover `<id>--*`) onto the canonical name. An absent
 * canonical dir takes it by one atomic rename; an existing one absorbs its missing entries. Never deletes a file —
 * a failed move is left for the tolerant reader.
 */
const reconcileSprintDir = async (root: AbsolutePath, id: string, canonicalDir: string): Promise<void> => {
  const memoKey = `${id}::${canonicalDir}`;
  if (reconciledDirs.has(memoKey)) return;
  const dir = sprintsDir(root);
  const entries = await listDir(dir);
  if (!entries.ok) return;
  let foundStale = false;
  for (const entry of entries.value) {
    const fullPath = join(dir, entry);
    if (fullPath === canonicalDir || parseIdFromName(entry) !== id) continue;
    foundStale = true;
    const renamed = await renamePath(fullPath, canonicalDir);
    if (!renamed.ok) await mergeIntoCanonical(fullPath, canonicalDir);
  }
  if (foundStale) return; // re-verified by the next save, which then finds a settled tree
  const canonicalExists = await pathExists(canonicalDir);
  if (canonicalExists.ok && canonicalExists.value) reconciledDirs.add(memoKey);
};

/**
 * The canonical `<id>--<slug>/` dir, after moving any legacy dir for the sprint onto it. Callers about to write side
 * files (progress.md, logs, worktrees) use this so those files land in the dir the readers resolve.
 */
export const ensureCanonicalSprintDir = async (root: AbsolutePath, id: SprintId, slug: Slug): Promise<string> => {
  const canonicalDir = sprintDir(root, id, slug);
  await reconcileSprintDir(root, String(id), canonicalDir);
  return canonicalDir;
};

/**
 * Lists every sprint under `<root>/sprints/`. Extracted to module scope (rather than nested in the
 * factory) purely to keep `createFsSprintRepository`'s own line count in check — behaviourally it
 * is the repo's `list()`.
 */
const listSprints = async (root: AbsolutePath): Promise<Result<readonly Sprint[], StorageError>> => {
  const dir = sprintsDir(root);
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);

  // Sort by the leading id (split on `--`) so chronological UUIDv7 order survives the slug
  // suffix — a `<id>--zzz` dir must still sort by its id, not the whole name.
  const sortedEntries = [...entries.value].sort((a, b) => parseIdFromName(a).localeCompare(parseIdFromName(b)));
  // Read every entry's sprint.json concurrently — each read is an independent disk round-trip,
  // and Promise.all preserves the input array's order regardless of settle order, so the
  // chronological order established above survives untouched.
  const reads = await Promise.all(
    sortedEntries.map(async (name) => {
      const path = join(dir, name, 'sprint.json');
      return { name, path, json: await readJson(path) };
    })
  );

  // Sort order can't pick the canonical sibling: the id-only comparator ties a bare/slugged pair over unspecified readdir order.
  return decodeDeduped(reads, fromJsonSprint, 'sprint', (s) => String(s.id));
};

export const createFsSprintRepository = (deps: FsSprintRepositoryDeps): SprintRepository => {
  const list = (): Promise<Result<readonly Sprint[], StorageError>> => listSprints(deps.root);

  return {
    async findById(id) {
      const dir = await resolveSprintDir(deps.root, id);
      return readEntity(dir === undefined ? undefined : join(dir, 'sprint.json'), fromJsonSprint, 'sprint', String(id));
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
      // Reconcile first so a legacy dir's execution.json + tasks.json end up beside the new sprint.json.
      await ensureCanonicalSprintDir(deps.root, sprint.id, sprint.slug);
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
