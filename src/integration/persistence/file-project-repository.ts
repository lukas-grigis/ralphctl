import type { Project } from '../../domain/entities/project.ts';
import { NotFoundError } from '../../domain/errors/not-found-error.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import type { ProjectRepository } from '../../domain/repositories/project-repository.ts';
import { Result } from '../../domain/result.ts';
import type { ProjectName } from '../../domain/values/project-name.ts';
import type { FileLocker } from './file-locker.ts';
import { readJsonFile, writeJsonFile } from './json-io.ts';
import {
  emptyProjectsFile,
  fromProject,
  type ProjectsFile,
  projectsFileSchema,
  toProject,
} from './schemas/project-schema.ts';
import { ensureLayoutDirsOnce, type StoragePaths } from './storage-paths.ts';

/**
 * `FileProjectRepository` — every project lives in the single envelope file
 * `<root>/config/projects.json`. Mutations are upsert-by-name under one lock
 * on that file, so concurrent saves from different processes serialise.
 *
 * "First read on a fresh install" returns `[]` rather than `NotFoundError`
 * — a missing `projects.json` is the same as having zero registered
 * projects.
 */
export class FileProjectRepository implements ProjectRepository {
  constructor(
    private readonly paths: StoragePaths,
    private readonly locker: FileLocker
  ) {}

  async save(project: Project): Promise<Result<void, StorageError>> {
    const file = this.paths.projectsFile;
    await ensureLayoutDirsOnce(this.paths);
    const locked = await this.locker.withLock(file, async () => {
      const existing = await this.readEnvelope();
      if (!existing.ok) return Result.error(existing.error);
      const next: ProjectsFile = {
        version: 1,
        projects: upsert(existing.value.projects, fromProject(project)),
      };
      return writeJsonFile(file, next, projectsFileSchema);
    });
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }

  async findByName(name: ProjectName): Promise<Result<Project, NotFoundError | StorageError>> {
    const all = await this.readEnvelope();
    if (!all.ok) return Result.error(all.error);
    const found = all.value.projects.find((p) => p.name === name);
    if (found === undefined) {
      return Result.error(
        new NotFoundError({
          entity: 'project',
          id: name,
          hint: 'Run `ralphctl project list` to see available projects.',
        })
      );
    }
    return toProject(found);
  }

  async list(): Promise<Result<readonly Project[], StorageError>> {
    const all = await this.readEnvelope();
    if (!all.ok) return Result.error(all.error);
    const projects: Project[] = [];
    for (const p of all.value.projects) {
      const built = toProject(p);
      if (!built.ok) return Result.error(built.error);
      projects.push(built.value);
    }
    return Result.ok(projects);
  }

  async remove(name: ProjectName): Promise<Result<void, NotFoundError | StorageError>> {
    const file = this.paths.projectsFile;
    await ensureLayoutDirsOnce(this.paths);
    const locked = await this.locker.withLock(file, async () => {
      const existing = await this.readEnvelope();
      if (!existing.ok) return Result.error(existing.error);
      const idx = existing.value.projects.findIndex((p) => p.name === name);
      if (idx === -1) {
        return Result.error(
          new NotFoundError({
            entity: 'project',
            id: name,
            hint: 'Run `ralphctl project list` to see available projects.',
          })
        );
      }
      const next: ProjectsFile = {
        version: 1,
        projects: existing.value.projects.filter((_, i) => i !== idx),
      };
      return writeJsonFile(file, next, projectsFileSchema);
    });
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }

  /**
   * Internal — reads the envelope, treating ENOENT as an empty file. Wraps
   * the schema mismatch / I/O outcomes from `readJsonFile` so callers see a
   * single `Result<ProjectsFile, StorageError>`.
   */
  private async readEnvelope(): Promise<Result<ProjectsFile, StorageError>> {
    const read = await readJsonFile(this.paths.projectsFile, projectsFileSchema);
    if (read.ok) return Result.ok(read.value);
    if (read.error.subCode === 'io' && errnoCode(read.error.cause) === 'ENOENT') {
      return Result.ok(emptyProjectsFile());
    }
    return Result.error(read.error);
  }
}

function upsert(current: ProjectsFile['projects'], next: ProjectsFile['projects'][number]): ProjectsFile['projects'] {
  const idx = current.findIndex((p) => p.name === next.name);
  if (idx === -1) return [...current, next];
  const copy = [...current];
  copy[idx] = next;
  return copy;
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}
