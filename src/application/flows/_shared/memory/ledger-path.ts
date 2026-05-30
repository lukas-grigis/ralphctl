import { join } from 'node:path';
import type { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** File name of the per-project append-only learnings ledger. */
export const LEARNINGS_LEDGER_FILE = 'learnings.ndjson';

/**
 * Resolve the absolute path of a project's learnings ledger:
 * `<memoryRoot>/<projectId>/learnings.ndjson`.
 *
 * Project-scoped under `memoryRoot` (which itself sits under `dataRoot`, durable). Both the
 * WRITE side (T12) and the READ side (T14a) resolve the path through this one helper so the
 * layout cannot drift between the appender and the loader.
 *
 * @public
 */
export const learningsLedgerPath = (
  memoryRoot: AbsolutePath,
  projectId: string
): Result<AbsolutePath, ValidationError> =>
  AbsolutePath.parse(join(String(memoryRoot), projectId, LEARNINGS_LEDGER_FILE));
