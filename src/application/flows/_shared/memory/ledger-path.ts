import { join } from 'node:path';
import type { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildSluggedName, resolveMemoryDir } from '@src/integration/persistence/storage.ts';

/** File name of the per-project append-only learnings ledger. */
export const LEARNINGS_LEDGER_FILE = 'learnings.ndjson';

/**
 * READ-side resolver for a project's learnings ledger. Tolerant of BOTH the new
 * `<memoryRoot>/<projectId>--<projectSlug>/learnings.ndjson` directory and the legacy bare
 * `<memoryRoot>/<projectId>/learnings.ndjson`. When neither memory directory exists yet (a project
 * that has never recorded a learning), this falls back to the bare `<projectId>/` path so the
 * first append still has a deterministic destination — `distill-learnings`'s load side simply
 * reads an absent ledger as "no candidates."
 *
 * Both the WRITE side (the appender) and the READ side (the loader) resolve the path through this
 * one helper so the layout cannot drift between them.
 *
 * @public
 */
export const resolveLearningsLedgerPath = async (
  memoryRoot: AbsolutePath,
  projectId: string
): Promise<Result<AbsolutePath, ValidationError>> => {
  const dir = (await resolveMemoryDir(memoryRoot, projectId)) ?? join(String(memoryRoot), projectId);
  return AbsolutePath.parse(join(dir, LEARNINGS_LEDGER_FILE));
};

/**
 * WRITE-side builder: the canonical `<memoryRoot>/<projectId>--<projectSlug>/learnings.ndjson`
 * path. Use when the project entity (and thus its slug) is in scope — no async scan needed, and
 * the slugged directory is created on first append by the atomic-write helper. Pure.
 *
 * @public
 */
export const learningsLedgerPathDirect = (
  memoryRoot: AbsolutePath,
  projectId: string,
  projectSlug: Slug
): Result<AbsolutePath, ValidationError> =>
  AbsolutePath.parse(join(String(memoryRoot), buildSluggedName(projectId, String(projectSlug)), LEARNINGS_LEDGER_FILE));
