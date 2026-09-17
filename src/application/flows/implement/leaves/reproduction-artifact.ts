import { join } from 'node:path';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { readJson, removeFile } from '@src/integration/io/fs.ts';
// Type-only: `reproduce.ts` imports this module's values, so a value import back would be a cycle.
import type { ReproductionArtifact } from '@src/application/flows/implement/leaves/reproduce.ts';

/**
 * The validated reproduction, saved next to the reproduce session's own files at
 * `<sprintDir>/implement/<taskId>/reproduce/artifact.json`, so a later launch of the same task can
 * reuse it.
 *
 * Why a relaunch needs it: when a defect-shaped task blocks, its whole uncommitted diff goes into
 * the quarantine stash, and that diff includes the failing test the reproduce session wrote. On the
 * relaunch the reproduce leaf therefore must not spawn again. A fresh session would write a second
 * failing test into the tree, and the restore only pops onto a clean tree, so the earlier work would
 * never come back. What the relaunch needs instead is the harness-validated description of the test
 * that is waiting in the stash: its path (so pre-task-verify can keep it out of the baseline), its
 * run command, the failure the harness saw, and the checksum the evaluator's tamper check compares
 * against. Only the harness writes this file, and only for a reproduction whose command it re-ran
 * and saw fail.
 *
 * It lives under the sprint dir rather than the repo, so an operator unblock (which rewrites the
 * task row) leaves it in place, and the harness never writes into the user's tree to keep it.
 *
 * Tolerant reader: a missing file reads as "nothing saved". An unparseable file or a schema miss is
 * an error the caller logs and then treats the same way. No migration is involved: the file is
 * per-launch harness state, and an unknown version only costs one relaunch its reproduction block.
 */
const REPRODUCTION_ARTIFACT_SCHEMA_VERSION = 1;

const persistedReproductionSchema = z.object({
  schemaVersion: z.literal(REPRODUCTION_ARTIFACT_SCHEMA_VERSION),
  testPath: z.string().min(1),
  runCommand: z.string().min(1),
  observedFailure: z.string(),
  relevantTests: z.array(z.string()),
  checksum: z.string().min(1),
});

/** `<reproduceDir>/artifact.json` — beside the session's `prompt.md` / `signals.json`. */
export const reproductionArtifactFile = (reproduceDir: AbsolutePath): Result<AbsolutePath, DomainError> =>
  AbsolutePath.parse(join(String(reproduceDir), 'artifact.json'));

export const saveReproductionArtifact = (
  writeFile: WriteFile,
  file: AbsolutePath,
  artifact: ReproductionArtifact
): Promise<Result<void, StorageError>> =>
  writeFile(file, `${JSON.stringify({ schemaVersion: REPRODUCTION_ARTIFACT_SCHEMA_VERSION, ...artifact }, null, 2)}\n`);

/** `Result.ok(undefined)` when nothing was saved; `Result.error` for a file that exists but can't be used. */
export const loadReproductionArtifact = async (
  file: AbsolutePath
): Promise<Result<ReproductionArtifact | undefined, StorageError>> => {
  const raw = await readJson(String(file));
  if (!raw.ok) return raw.error instanceof NotFoundError ? Result.ok(undefined) : Result.error(raw.error);
  const parsed = persistedReproductionSchema.safeParse(raw.value);
  if (!parsed.success) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `saved reproduction does not match its schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        path: String(file),
      })
    );
  }
  const { testPath, runCommand, observedFailure, relevantTests, checksum } = parsed.data;
  return Result.ok({ testPath, runCommand, observedFailure, relevantTests, checksum });
};

/**
 * Forget the saved reproduction. Called before a fresh reproduce spawn, so the file only ever
 * describes the latest spawn, and only when that spawn was accepted. A missing file is already the
 * wanted state.
 */
export const removeReproductionArtifact = async (file: AbsolutePath): Promise<Result<void, StorageError>> => {
  const removed = await removeFile(String(file));
  if (removed.ok || removed.error instanceof NotFoundError) return Result.ok(undefined);
  return Result.error(removed.error);
};
