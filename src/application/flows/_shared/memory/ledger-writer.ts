import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbsolutePath as AbsolutePathCtor } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import {
  type LearningRecord,
  parseLearningLine,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';
import { renderLearningsMd } from '@src/application/flows/_shared/memory/render-learnings-md.ts';

/** Sibling `learnings.md` mirror name for a `learnings.ndjson` ledger path. */
const LEARNINGS_MD = 'learnings.md';

/**
 * Compute the `learnings.md` mirror path next to a `learnings.ndjson` ledger path. Pure.
 *
 * @public
 */
export const learningsMdPath = (ledgerPath: AbsolutePath): AbsolutePath | undefined => {
  const parsed = AbsolutePathCtor.parse(join(dirname(String(ledgerPath)), LEARNINGS_MD));
  return parsed.ok ? parsed.value : undefined;
};

/**
 * Regenerate the human-readable `learnings.md` mirror next to a ledger from an ALREADY-PARSED record
 * set. The canonical source of truth is always the NDJSON ledger; the markdown is a derived view, so
 * a regeneration failure is BEST-EFFORT — it is logged at warn and swallowed (the caller's primary
 * write to the ledger already succeeded; the mirror heals on the next write). Returns `Result.ok`
 * even on a swallowed mirror failure so callers never block on the derived artefact.
 *
 * @public
 */
export const mirrorLearningsMd = async (
  ledgerPath: AbsolutePath,
  records: readonly LearningRecord[],
  writeFile: WriteFile,
  log: Logger
): Promise<Result<void, never>> => {
  const mdPath = learningsMdPath(ledgerPath);
  if (mdPath === undefined) {
    log.warn('could not derive learnings.md path from ledger path', { path: String(ledgerPath) });
    return Result.ok(undefined);
  }
  const written = await writeFile(mdPath, renderLearningsMd(records));
  if (!written.ok) {
    log.warn('learnings.md mirror write failed (ledger is still authoritative)', {
      path: String(mdPath),
      error: written.error.message,
    });
  }
  return Result.ok(undefined);
};

/**
 * Read + parse the full ledger off disk into a record set, dropping blank and malformed lines (a
 * malformed line is logged at warn — the mirror is a best-effort view, so one bad row should not
 * abort the regeneration). An absent ledger yields an empty set. Used by the append path, which only
 * holds the just-appended records and must reread to render the WHOLE ledger.
 */
const readAllRecords = async (ledgerPath: AbsolutePath, log: Logger): Promise<readonly LearningRecord[]> => {
  let body: string;
  try {
    body = await fs.readFile(String(ledgerPath), 'utf8');
  } catch {
    return []; // absent / unreadable → render an empty mirror
  }
  const records: LearningRecord[] = [];
  for (const line of body.split('\n')) {
    const parsed = parseLearningLine(line);
    if (!parsed.ok) {
      log.warn('skipping malformed learnings.ndjson line while mirroring', { error: parsed.error.message });
      continue;
    }
    if (parsed.value !== undefined) records.push(parsed.value);
  }
  return records;
};

/**
 * Append one or more learning records to the NDJSON ledger, then regenerate the `learnings.md`
 * mirror from the FULL ledger so the human-readable view stays current on every write. The append is
 * the authoritative, crash-safe operation (one `AppendFile` call per record); the mirror is a derived
 * best-effort regeneration that rereads the whole ledger and renders it.
 *
 * An append failure is returned as an error (the caller decides — `append-learnings` logs + continues
 * per its best-effort contract). The subsequent mirror regeneration never fails the call.
 *
 * @public
 */
export const appendLearningsAndMirror = async (
  ledgerPath: AbsolutePath,
  records: readonly LearningRecord[],
  deps: { readonly appendFile: AppendFile; readonly writeFile: WriteFile; readonly log: Logger }
): Promise<Result<void, StorageError>> => {
  for (const record of records) {
    const appended = await deps.appendFile(ledgerPath, serializeLearningRecord(record));
    if (!appended.ok) return Result.error(appended.error);
  }
  const all = await readAllRecords(ledgerPath, deps.log);
  await mirrorLearningsMd(ledgerPath, all, deps.writeFile, deps.log);
  return Result.ok(undefined) as Result<void, StorageError>;
};
