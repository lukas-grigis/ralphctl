import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonProject, toJsonProject } from '@src/integration/persistence/project/project.schema.ts';
import { listDir, readJson, removeFile, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { parseIdFromName, projectFile, projectsDir, resolveProjectPath } from '@src/integration/persistence/storage.ts';
import { decodeDeduped, readEntity } from '@src/integration/persistence/shared/read-entities.ts';

export interface FsProjectRepositoryDeps {
  /** Root of the on-disk layout. Per the path resolver, projects land under `<root>/projects/`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `ProjectRepository`. One file per project under
 * `<root>/projects/<id>--<slug>.json`. Reads resolve both the slugged name and the legacy bare
 * `<id>.json` via {@link resolveProjectPath} (tolerant reader); `save` writes the slugged name
 * and reconciles away any stale sibling (bare id, or an old-slug name). Listing scans the
 * directory and reads each file; `findBySlug` reuses `list` since slugs are globally unique and
 * projects are typically few.
 */
/**
 * After writing the canonical `<id>--<slug>.json`, delete any other project file that resolves to
 * the SAME id (the legacy bare `<id>.json`, or a stale `<id>--<oldSlug>.json` left by a slug
 * rename). Best-effort: a removal failure is swallowed — the tolerant reader still prefers the
 * canonical name, so a leftover stale file is harmless and the next save retries the cleanup.
 */
const reconcileStaleProjectSiblings = async (root: AbsolutePath, id: string, canonicalFile: string): Promise<void> => {
  const dir = projectsDir(root);
  const entries = await listDir(dir);
  if (!entries.ok) return;
  for (const entry of entries.value) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = join(dir, entry);
    if (fullPath === canonicalFile) continue;
    if (parseIdFromName(entry) !== id) continue;
    await removeFile(fullPath); // best-effort
  }
};

/**
 * Lists every project under `<root>/projects/`. Extracted to module scope (rather than nested in
 * the factory) purely to keep `createFsProjectRepository`'s own line count in check —
 * behaviourally it is the repo's `list()`.
 */
const listProjects = async (root: AbsolutePath): Promise<Result<readonly Project[], StorageError>> => {
  const dir = projectsDir(root);
  const entries = await listDir(dir);
  if (!entries.ok) return Result.error(entries.error);

  const jsonFiles = entries.value.filter((f) => f.endsWith('.json')).sort();
  // Read every project file concurrently — each read is an independent disk round-trip, and
  // Promise.all preserves the input array's order regardless of settle order, so the sorted
  // order established above survives untouched.
  const reads = await Promise.all(
    jsonFiles.map(async (name) => {
      const path = join(dir, name);
      return { name, path, json: await readJson(path) };
    })
  );

  // Sort order can't pick the canonical sibling: `-` < `.` in ASCII reads `<id>--<slug>.json` before the stale `<id>.json`.
  return decodeDeduped(reads, fromJsonProject, 'project', (p) => String(p.id));
};

export const createFsProjectRepository = (deps: FsProjectRepositoryDeps): ProjectRepository => {
  const list = (): Promise<Result<readonly Project[], StorageError>> => listProjects(deps.root);

  return {
    async findById(id) {
      return readEntity(await resolveProjectPath(deps.root, id), fromJsonProject, 'project', String(id));
    },

    async findBySlug(slug) {
      const all = await list();
      if (!all.ok) return Result.error(all.error);
      const match = all.value.find((p) => p.slug === slug);
      if (match === undefined) {
        return Result.error(
          new NotFoundError({
            entity: 'project',
            id: String(slug),
            message: `project with slug '${String(slug)}' not found`,
          })
        );
      }
      return Result.ok(match);
    },

    list,

    async save(project) {
      const canonicalFile = projectFile(deps.root, project.id, project.slug);
      const written = await writeJsonAtomic(canonicalFile, toJsonProject(project));
      if (!written.ok) return written;
      // Reconcile only AFTER the new file is durably written, so a crash can never leave the
      // project with no readable file (the resolver still finds the old one until cleanup runs).
      await reconcileStaleProjectSiblings(deps.root, String(project.id), canonicalFile);
      return Result.ok(undefined);
    },

    async remove(id) {
      const path = await resolveProjectPath(deps.root, id);
      if (path === undefined) {
        return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
      }
      const result = await removeFile(path);
      if (!result.ok && result.error instanceof NotFoundError) {
        return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
      }
      return result;
    },
  };
};
