import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Lock-file path for serialising whole-flow runs against one working tree.
 *
 * Keyed by a hash of the absolute working-tree path rather than a `RepositoryId` — two
 * different `Repository` aggregates pointing at the same physical clone still serialize
 * correctly. Hash truncated to 16 hex chars: collision-resistant within any realistic
 * number of co-located checkouts on one machine.
 */
export const repoLockFile = (
  locksRoot: AbsolutePath,
  worktreePath: AbsolutePath
): Result<AbsolutePath, ValidationError> => {
  const hash = createHash('sha1').update(String(worktreePath)).digest('hex').slice(0, 16);
  return AbsolutePath.parse(join(String(locksRoot), `repo-${hash}.lock`));
};
