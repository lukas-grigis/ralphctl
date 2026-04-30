import { mkdir, readdir, rm } from 'node:fs/promises';

import type { LoggerPort } from '../../business/ports/logger-port.ts';
import type { Sprint } from '../../domain/entities/sprint.ts';
import { NotFoundError } from '../../domain/errors/not-found-error.ts';
import { StorageError } from '../../domain/errors/storage-error.ts';
import type { SprintRepository } from '../../domain/repositories/sprint-repository.ts';
import { Result } from '../../domain/result.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';
import type { FileLocker } from './file-locker.ts';
import { readJsonFile, writeJsonFile } from './json-io.ts';
import { fromSprint, sprintJsonSchema, toSprint } from './schemas/sprint-schema.ts';
import { ensureLayoutDirsOnce, type StoragePaths } from './storage-paths.ts';

/**
 * `FileSprintRepository` — persists sprints under
 * `<root>/data/sprints/<sprint-id>/sprint.json`.
 *
 * Concurrency: each sprint is locked by its own `sprint.json.lock` so two
 * different sprints can be saved in parallel without contention. Listing is
 * lock-free and tolerant of dirs in transit.
 */
export class FileSprintRepository implements SprintRepository {
  constructor(
    private readonly paths: StoragePaths,
    private readonly locker: FileLocker,
    /** Optional — when supplied, `list()` warns instead of skipping silently. */
    private readonly logger?: LoggerPort
  ) {}

  async save(sprint: Sprint): Promise<Result<void, StorageError>> {
    const dir = this.paths.sprintDir(sprint.id);
    const file = this.paths.sprintFile(sprint.id);
    try {
      await ensureLayoutDirsOnce(this.paths);
      await mkdir(dir, { recursive: true });
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to create sprint dir ${dir}: ${stringifyError(err)}`,
          path: dir,
          cause: err,
        })
      );
    }
    const locked = await this.locker.withLock(file, () => writeJsonFile(file, fromSprint(sprint), sprintJsonSchema));
    // `withLock` returns `Result<Result<void, StorageError>, StorageError>`;
    // flatten so callers see a single Result.
    if (!locked.ok) return Result.error(locked.error);
    return locked.value;
  }

  async findById(id: SprintId): Promise<Result<Sprint, NotFoundError | StorageError>> {
    const file = this.paths.sprintFile(id);
    const read = await readJsonFile(file, sprintJsonSchema);
    if (!read.ok) {
      if (isMissingFile(read.error)) {
        return Result.error(
          new NotFoundError({
            entity: 'sprint',
            id,
            hint: 'Run `ralphctl sprint list` to see available sprints.',
          })
        );
      }
      return Result.error(read.error);
    }
    return toSprint(read.value);
  }

  async list(): Promise<Result<readonly Sprint[], StorageError>> {
    let entries: string[];
    try {
      const dirents = await readdir(this.paths.sprintsDir, {
        withFileTypes: true,
      });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      // No sprints directory yet — that's an empty list, not a failure.
      if (errnoCode(err) === 'ENOENT') {
        return Result.ok([]);
      }
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to list sprints in ${this.paths.sprintsDir}: ${stringifyError(err)}`,
          path: this.paths.sprintsDir,
          cause: err,
        })
      );
    }

    // Read all sprint files concurrently. Corrupt entries are skipped with
    // a warning (preserving the prior silent-skip behavior) so a single bad
    // dir doesn't break `sprint list` for the user.
    const reads = await Promise.all(
      entries.map(async (name) => {
        // Trust the directory name as a sprint id — corrupt names will simply
        // fail to read their `sprint.json` below and be skipped. We use it
        // purely as a path segment; the downstream schema check is the gate.
        const file = this.paths.sprintFile(name as unknown as SprintId);
        const read = await readJsonFile(file, sprintJsonSchema);
        if (!read.ok) {
          this.logger?.warn('Skipping corrupt sprint dir', {
            path: file,
            cause: read.error.message,
          });
          return null;
        }
        const built = toSprint(read.value);
        if (!built.ok) {
          this.logger?.warn('Skipping corrupt sprint dir', {
            path: file,
            cause: built.error.message,
          });
          return null;
        }
        return built.value;
      })
    );

    const sprints = reads.filter((s): s is Sprint => s !== null);
    return Result.ok(sprints);
  }

  async remove(id: SprintId): Promise<Result<void, NotFoundError | StorageError>> {
    const dir = this.paths.sprintDir(id);
    try {
      await rm(dir, { recursive: true });
      return Result.ok();
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        return Result.error(
          new NotFoundError({
            entity: 'sprint',
            id,
            hint: 'Run `ralphctl sprint list` to see available sprints.',
          })
        );
      }
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to remove sprint dir ${dir}: ${stringifyError(err)}`,
          path: dir,
          cause: err,
        })
      );
    }
  }
}

function isMissingFile(err: StorageError): boolean {
  return err.subCode === 'io' && errnoCode(err.cause) === 'ENOENT';
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
