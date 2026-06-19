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
 * WRITE-side resolver: the learnings ledger path the appender should write to, picking the EXISTING
 * memory dir when one is present rather than unconditionally building the slugged name. This is the
 * critical anti-stranding rule — a user with a legacy bare `<projectId>/` dir (e.g. one who declined
 * the migration) keeps appending to THAT one dir instead of having a second `<id>--<slug>/` dir
 * created beside it (which would strand the legacy learnings AND permanently block the migration's
 * dry-run on a both-dirs collision).
 *
 * Resolution order:
 *  1. an existing `<projectId>--<projectSlug>/` (or any `<projectId>--<…>/`) dir wins;
 *  2. else an existing legacy bare `<projectId>/` dir is used (keep appending there);
 *  3. else NEITHER exists — build (and let the atomic writer create) the canonical
 *     `<projectId>--<projectSlug>/` dir, so a brand-new project lands on the human-readable name.
 *
 * The consented migration is the only thing that renames a legacy dir onto the slugged name; until
 * then the writer never splits. Async because it scans the memory root — these leaves are already
 * async, so the scan is free. Use this on the WRITE side in place of the old pure direct-build.
 *
 * @public
 */
export const resolveWritableLearningsLedgerPath = async (
  memoryRoot: AbsolutePath,
  projectId: string,
  projectSlug: Slug
): Promise<Result<AbsolutePath, ValidationError>> => {
  const existing = await resolveMemoryDir(memoryRoot, projectId);
  const dir = existing ?? join(String(memoryRoot), buildSluggedName(projectId, String(projectSlug)));
  return AbsolutePath.parse(join(dir, LEARNINGS_LEDGER_FILE));
};
