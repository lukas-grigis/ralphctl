import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import { fromJsonProject, toJsonProject } from '@src/integration/persistence/project/project.schema.ts';
import { listDir, readJson, removeFile, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { projectFile, projectsDir } from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';

export interface FsProjectRepositoryDeps {
  /** Root of the on-disk layout. Per the path resolver, projects land under `<root>/projects/`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `ProjectRepository`. One file per project under `<root>/projects/<id>.json`.
 * Listing scans the directory and reads each file; `findBySlug` reuses `list` since slugs are
 * globally unique and projects are typically few.
 */
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
      const path = projectFile(deps.root, id);
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
      return writeJsonAtomic(projectFile(deps.root, project.id), toJsonProject(project));
    },

    async remove(id) {
      const result = await removeFile(projectFile(deps.root, id));
      if (!result.ok && result.error instanceof NotFoundError) {
        return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
      }
      return result;
    },
  };
};
