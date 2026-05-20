import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { HttpUrlSchema, SprintIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { SetupRunSchema } from '@src/integration/persistence/sprint-execution/setup-run.schema.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

export const SprintExecutionSchema = z.object({
  /**
   * `id` and `sprintId` carry the same value — execution is keyed by the partner sprint.
   * Both fields are persisted so the on-disk record satisfies `Entity<SprintId>` without
   * losing the historical `sprintId` field name.
   */
  id: SprintIdSchema,
  sprintId: SprintIdSchema,
  branch: z.union([z.string(), z.null()]),
  pullRequestUrl: z.union([HttpUrlSchema, z.null()]),
  setupRanAt: z.array(SetupRunSchema).readonly(),
});

/**
 * Decode a persisted sprint-execution payload. Two forward-compat shims fire before zod
 * validation so legacy on-disk files load without operator intervention:
 *
 *  1. The earliest format carried `sprintId` only (no `id`); the `Entity<SprintId>` base
 *     contract added `id` later. Fill it in from `sprintId`.
 *  2. The v0.7.0 setup-script-runner expanded `SetupRun` from `{ repositoryId, ranAt }` to a
 *     structured row carrying command / exit / outcome / stdoutTail / stderrTail. Upgrade
 *     legacy two-field rows by populating the new fields with neutral defaults
 *     (`outcome: 'success'`, empty command + tails, `exitCode: 0`, `durationMs: 0`). This
 *     preserves the historical fact "setup ran at this time on this repo" without
 *     fabricating output the harness didn't observe.
 *
 * Both shims self-heal on the next save — new writes always emit the current shape.
 */
export const fromJsonSprintExecution = (input: unknown): Result<SprintExecution, ParseError> => {
  const withId = upgradeMissingId(input);
  const withMigratedRuns = upgradeLegacySetupRuns(withId);
  return safeParseToResult(SprintExecutionSchema, withMigratedRuns);
};

const upgradeMissingId = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  if ('id' in obj || !('sprintId' in obj)) return input;
  return { ...obj, id: obj.sprintId };
};

const upgradeLegacySetupRuns = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  const runs = obj.setupRanAt;
  if (!Array.isArray(runs)) return input;
  const migrated = runs.map((run) => {
    if (typeof run !== 'object' || run === null) return run;
    const entry = run as Record<string, unknown>;
    // Already in the new shape — keep it. A persisted `outcome` is the unambiguous marker.
    if ('outcome' in entry) return entry;
    return {
      ...entry,
      command: typeof entry.command === 'string' ? entry.command : '',
      exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : 0,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
      stdoutTailBytes: typeof entry.stdoutTailBytes === 'string' ? entry.stdoutTailBytes : '',
      stderrTailBytes: typeof entry.stderrTailBytes === 'string' ? entry.stderrTailBytes : '',
      outcome: 'success',
    };
  });
  return { ...obj, setupRanAt: migrated };
};

export const toJsonSprintExecution = (execution: SprintExecution): unknown => execution;

type _checkSprintExecution = Compatible<SprintExecution, z.infer<typeof SprintExecutionSchema>>;
const _typeChecks: [_checkSprintExecution] = [true];
void _typeChecks;
