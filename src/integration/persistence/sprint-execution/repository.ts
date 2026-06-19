import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  fromJsonSprintExecution,
  toJsonSprintExecution,
} from '@src/integration/persistence/sprint-execution/sprint-execution.schema.ts';
import { readJson, removeFile, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { resolveSprintDir, sprintsDir } from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';

export interface FsSprintExecutionRepositoryDeps {
  /** Root of the on-disk layout. Each sprint's execution lives at `<root>/sprints/<id>--<slug>/execution.json`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `SprintExecutionRepository`. The execution file lives next to its sprint's
 * `sprint.json` so the two stay co-located on disk. There is no `list` capability — executions
 * are always accessed via their parent sprint id.
 *
 * The execution aggregate carries only a `sprintId` (no slug), so every path goes through the
 * tolerant {@link resolveSprintDir} resolver. On `save` the parent sprint dir already exists
 * (`save-sprint` runs before `save-sprint-execution`); if it somehow does not, the write falls
 * back to the bare `<id>/` dir, which the next sprint save reconciles onto the canonical name.
 */
export const createFsSprintExecutionRepository = (deps: FsSprintExecutionRepositoryDeps): SprintExecutionRepository => {
  /** Resolve the existing sprint dir, falling back to the bare `<id>/` path for first writes. */
  const dirFor = async (id: SprintId): Promise<string> =>
    (await resolveSprintDir(deps.root, id)) ?? join(sprintsDir(deps.root), String(id));

  return {
    async findById(id) {
      const dir = await resolveSprintDir(deps.root, id);
      if (dir === undefined) {
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      }
      const path = join(dir, 'execution.json');
      const json = await readJson(path);
      if (!json.ok) {
        if (json.error instanceof NotFoundError) {
          return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
        }
        return Result.error(json.error);
      }
      return decode((input) => fromJsonSprintExecution(input, path), json.value, { entity: 'sprint-execution', path });
    },

    async save(execution: SprintExecution) {
      const path = join(await dirFor(execution.sprintId), 'execution.json');
      return writeJsonAtomic(path, toJsonSprintExecution(execution));
    },

    async remove(id) {
      const dir = await resolveSprintDir(deps.root, id);
      if (dir === undefined) {
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      }
      const result = await removeFile(join(dir, 'execution.json'));
      if (!result.ok && result.error instanceof NotFoundError) {
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      }
      return result;
    },
  };
};
