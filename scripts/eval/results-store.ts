import { join } from 'node:path';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { promises as fs } from 'node:fs';
import { EVAL_FLOWS } from './fixture-schema.ts';
import { renderSummary } from './report.ts';
import type { ResultsFile, TrialRecord } from './types.ts';

/**
 * Where a run's output lands: `<runDir>/trials.ndjson` (one line appended per finished trial, so a
 * crash keeps every finished trial), then `results.json` + `summary.md` written atomically at the
 * end. Trial artifacts (`prompt.md`, `signals.json`, …) are written by `run-trial.ts` under
 * `<runDir>/trials/`.
 */
export interface ResultsStore {
  readonly runDir: string;
  appendTrial(record: TrialRecord): Promise<Result<void, StorageError>>;
  finalize(results: ResultsFile): Promise<Result<void, StorageError>>;
}

export interface ResultsStoreDeps {
  readonly runDir: string;
  readonly appendFile: AppendFile;
  readonly writeFile: WriteFile;
}

const abs = (path: string): Result<AbsolutePath, StorageError> => {
  const parsed = AbsolutePath.parse(path);
  return parsed.ok
    ? Result.ok(parsed.value)
    : Result.error(new StorageError({ subCode: 'io', message: `not an absolute path: ${path}`, path }));
};

export const createResultsStore = (deps: ResultsStoreDeps): ResultsStore => ({
  runDir: deps.runDir,
  async appendTrial(record) {
    const path = abs(join(deps.runDir, 'trials.ndjson'));
    if (!path.ok) return Result.error(path.error);
    return deps.appendFile(path.value, `${JSON.stringify(record)}\n`);
  },
  async finalize(results) {
    const jsonPath = abs(join(deps.runDir, 'results.json'));
    const mdPath = abs(join(deps.runDir, 'summary.md'));
    if (!jsonPath.ok) return Result.error(jsonPath.error);
    if (!mdPath.ok) return Result.error(mdPath.error);
    const wroteJson = await deps.writeFile(jsonPath.value, `${JSON.stringify(results, null, 2)}\n`);
    if (!wroteJson.ok) return wroteJson;
    return deps.writeFile(mdPath.value, renderSummary(results));
  },
});

/** Loose structural check on a stored trial — enough to trust the fields the analysis reads. */
const StoredTrialSchema = z
  .object({
    fixtureId: z.string(),
    flow: z.enum(EVAL_FLOWS),
    variant: z.string(),
    trialIndex: z.number(),
    arm: z.string(),
    tier: z.enum(['regression', 'capability']),
    cluster: z.string(),
    origin: z.enum(['synthetic', 'real']),
    graded: z.boolean(),
    correct: z.boolean(),
    structurallyValid: z.boolean(),
    nudgeCount: z.number().nullable(),
    usage: z.object({
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      cacheReadTokens: z.number().nullable().optional(),
      cacheCreationTokens: z.number().nullable().optional(),
      durationMs: z.number(),
      metered: z.boolean(),
    }),
    artifactDir: z.string(),
  })
  .loose();

const StoredResultsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    k: z.number().int().positive(),
    arms: z.array(z.object({ name: z.string() }).loose()),
    trials: z.array(StoredTrialSchema),
  })
  .loose();

/** Read a `results.json` written by {@link createResultsStore}. */
export const readResults = async (path: string): Promise<Result<ResultsFile, ParseError | StorageError>> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (cause) {
    const missing = (cause as { code?: unknown }).code === 'ENOENT';
    return Result.error(
      missing
        ? new StorageError({ subCode: 'io', message: `results file not found: ${path}`, path, cause })
        : new ParseError({ subCode: 'invalid-json', message: `${path}: ${messageOf(cause)}`, cause })
    );
  }
  const parsed = StoredResultsSchema.safeParse(raw);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        cause: parsed.error,
      })
    );
  }
  // Results files written before cache accounting have no cache budget fields; default them so the
  // offline report renders old runs (their trials' cache usage stays absent = n/a).
  const file = raw as ResultsFile;
  const budget = file.budget as Partial<ResultsFile['budget']> &
    Omit<ResultsFile['budget'], 'cacheReadTokens' | 'cacheCreationTokens'>;
  return Result.ok({
    ...file,
    budget: {
      ...budget,
      cacheReadTokens: budget.cacheReadTokens ?? 0,
      cacheCreationTokens: budget.cacheCreationTokens ?? 0,
    },
  });
};
