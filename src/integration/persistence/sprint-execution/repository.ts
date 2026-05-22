import { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  fromJsonSprintExecution,
  toJsonSprintExecution,
} from '@src/integration/persistence/sprint-execution/sprint-execution.schema.ts';
import { readJson, removeFile, writeJsonAtomic } from '@src/integration/io/fs.ts';
import { executionFile } from '@src/integration/persistence/storage.ts';
import { decode } from '@src/integration/persistence/shared/decode.ts';

export interface FsSprintExecutionRepositoryDeps {
  /** Root of the on-disk layout. Each sprint's execution lives at `<root>/sprints/<id>/execution.json`. */
  readonly root: AbsolutePath;
}

/**
 * Filesystem-backed `SprintExecutionRepository`. The execution file lives next to its sprint's
 * `sprint.json` so the two stay co-located on disk. There is no `list` capability — executions
 * are always accessed via their parent sprint id.
 */
export const createFsSprintExecutionRepository = (
  deps: FsSprintExecutionRepositoryDeps
): SprintExecutionRepository => ({
  async findById(id) {
    const path = executionFile(deps.root, id);
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
    return writeJsonAtomic(executionFile(deps.root, execution.sprintId), toJsonSprintExecution(execution));
  },

  async remove(id) {
    const result = await removeFile(executionFile(deps.root, id));
    if (!result.ok && result.error instanceof NotFoundError) {
      return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
    }
    return result;
  },
});
