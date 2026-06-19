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
import { decode } from '@src/integration/persistence/shared/decode.ts';

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

export const createFsProjectRepository = (deps: FsProjectRepositoryDeps): ProjectRepository => {
  const list = async (): Promise<Result<readonly Project[], StorageError>> => {
    const dir = projectsDir(deps.root);
    const entries = await listDir(dir);
    if (!entries.ok) return Result.error(entries.error);

    const jsonFiles = entries.value.filter((f) => f.endsWith('.json')).sort();
    const items: Project[] = [];
    for (const file of jsonFiles) {
      const path = `${dir}/${file}`;
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) continue; // race: file deleted between list and read
        return Result.error(json.error);
      }
      const decoded = decode(fromJsonProject, json.value, { entity: 'project', path });
      if (!decoded.ok) return Result.error(decoded.error);
      items.push(decoded.value);
    }
    return Result.ok(items);
  };

  return {
    async findById(id) {
      const path = await resolveProjectPath(deps.root, id);
      if (path === undefined) {
        return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
      }
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) {
          return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
        }
        return Result.error(json.error);
      }
      return decode(fromJsonProject, json.value, { entity: 'project', path });
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
