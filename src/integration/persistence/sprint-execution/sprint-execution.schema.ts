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
 * Decode a persisted sprint-execution payload. Forward-compat shim: an early on-disk format
 * carried `sprintId` only (no `id`); fill it in from `sprintId` before zod validation so legacy
 * files load. New writes always emit both fields, so the shim only fires for legacy payloads
 * and self-heals on the next save.
 */
export const fromJsonSprintExecution = (input: unknown): Result<SprintExecution, ParseError> => {
  const normalised =
    typeof input === 'object' && input !== null && 'sprintId' in input && !('id' in input)
      ? { ...(input as Record<string, unknown>), id: (input as { sprintId: unknown }).sprintId }
      : input;
  return safeParseToResult(SprintExecutionSchema, normalised);
};

export const toJsonSprintExecution = (execution: SprintExecution): unknown => execution;

type _checkSprintExecution = Compatible<SprintExecution, z.infer<typeof SprintExecutionSchema>>;
const _typeChecks: [_checkSprintExecution] = [true];
void _typeChecks;
