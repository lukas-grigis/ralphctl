import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
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
  currentSprintDir,
  parseIdFromName,
  resolveSprintDir,
  sprintDir,
  sprintsDir,
} from '@src/integration/persistence/storage.ts';
import { decodeDeduped, readEntity } from '@src/integration/persistence/shared/read-entities.ts';
import { repairSprintWorktrees, SPRINT_WORKTREES_DIR } from '@src/integration/persistence/sprint/sprint-worktrees.ts';

export interface FsSprintRepositoryDeps {
  /** Root of the on-disk layout. Per the path resolver, sprints land under `<root>/sprints/`. */
  readonly root: AbsolutePath;
  /** Serialises `update()`. Absent runs it unlocked — fine for tests and single-writer callers. */
  readonly fileLocker?: FileLocker;
  /** Where `update()`'s per-sprint lock lives — outside the sprint dir, which a slug rename moves. */
  readonly locksRoot?: AbsolutePath;
}

/**
 * Filesystem-backed `SprintRepository`. Each sprint owns its own directory under
 * `<root>/sprints/<id>--<slug>/` containing `sprint.json` (the aggregate this repo manages) plus
 * sibling files maintained by `SprintExecutionRepository` and `TaskRepository`. Removing a
 * sprint via `remove()` deletes the whole directory — execution and task files vanish with it.
 *
 * Reads resolve both the slugged dir and the legacy bare `<id>/` dir via {@link resolveSprintDir}
 * (tolerant reader). `save` first brings any other dir for the id onto the canonical `<id>--<slug>/`
 * name via {@link ensureCanonicalSprintDir}, THEN writes `sprint.json` into the dir that now holds the sprint.
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

const SPRINT_FILE = 'sprint.json';

/**
 * Move each entry the canonical dir lacks out of `staleDir`; a clashing entry stays put, so `rmdir` keeps the dir.
 * Returns whether the worktrees dir was among the moved entries.
 */
const mergeIntoCanonical = async (staleDir: string, canonicalDir: string): Promise<boolean> => {
  const children = await listDir(staleDir);
  if (!children.ok) return false;
  let movedWorktrees = false;
  for (const child of children.value) {
    const target = join(canonicalDir, child);
    const taken = await pathExists(target);
    if (!taken.ok || taken.value) continue;
    const moved = await renamePath(join(staleDir, child), target);
    if (moved.ok && child === SPRINT_WORKTREES_DIR) movedWorktrees = true;
  }
  await removeEmptyDir(staleDir);
  return movedWorktrees;
};

/**
 * Bring every other dir for `id` (the legacy bare `<id>/` or a leftover `<id>--*`) onto the canonical name. An absent
 * canonical dir takes it by one atomic rename; an existing one absorbs its missing entries. Never deletes a file —
 * a failed move is left for the tolerant reader. Moved worktrees get their links re-pointed at the new path.
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
    const movedWorktrees = renamed.ok || (await mergeIntoCanonical(fullPath, canonicalDir));
    if (movedWorktrees) await repairSprintWorktrees(canonicalDir);
  }
  if (foundStale) return; // re-verified by the next save, which then finds a settled tree
  const canonicalExists = await pathExists(canonicalDir);
  if (canonicalExists.ok && canonicalExists.value) reconciledDirs.add(memoKey);
};

/**
 * The sprint's dir after moving any legacy dir for it onto the canonical `<id>--<slug>/` name — or, when that move
 * failed, the dir still holding the data. Callers about to write side files (progress.md, logs, worktrees) use this
 * so those files land in the dir the readers resolve.
 */
export const ensureCanonicalSprintDir = async (root: AbsolutePath, id: SprintId, slug: Slug): Promise<string> => {
  await reconcileSprintDir(root, String(id), sprintDir(root, id, slug));
  return currentSprintDir(root, id, slug);
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
      const path = join(dir, name, SPRINT_FILE);
      return { name, path, json: await readJson(path) };
    })
  );

  // Sort order can't pick the canonical sibling: the id-only comparator ties a bare/slugged pair over unspecified readdir order.
  return decodeDeduped(reads, fromJsonSprint, 'sprint', (s) => String(s.id));
};

export const createFsSprintRepository = (deps: FsSprintRepositoryDeps): SprintRepository => {
  const list = (): Promise<Result<readonly Sprint[], StorageError>> => listSprints(deps.root);

  const findById: SprintRepository['findById'] = async (id) => {
    const dir = await resolveSprintDir(deps.root, id);
    return readEntity(dir === undefined ? undefined : join(dir, SPRINT_FILE), fromJsonSprint, 'sprint', String(id));
  };

  const save: SprintRepository['save'] = async (sprint) => {
    // Write where execution.json + tasks.json ended up, so a failed rename never splits sprint.json off them.
    const dir = await ensureCanonicalSprintDir(deps.root, sprint.id, sprint.slug);
    return writeJsonAtomic(join(dir, SPRINT_FILE), toJsonSprint(sprint));
  };

  const update: SprintRepository['update'] = async (id, mutate) => {
    const readModifyWrite = async (): Promise<Result<Sprint, DomainError>> => {
      const fresh = await findById(id);
      if (!fresh.ok) return Result.error(fresh.error);
      const next = mutate(fresh.value);
      if (!next.ok) return Result.error(next.error);
      if (next.value === fresh.value) return Result.ok(fresh.value);
      const saved = await save(next.value);
      return saved.ok ? Result.ok(next.value) : Result.error(saved.error);
    };
    if (deps.fileLocker === undefined || deps.locksRoot === undefined) return readModifyWrite();
    const lockPath = AbsolutePath.parse(join(String(deps.locksRoot), `sprint-${String(id)}.lock`));
    if (!lockPath.ok) return readModifyWrite();
    const locked = await deps.fileLocker.withLock(lockPath.value, readModifyWrite, { purpose: 'sprint update' });
    return locked.ok ? locked.value : Result.error(locked.error);
  };

  return {
    findById,

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
    save,
    update,

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
