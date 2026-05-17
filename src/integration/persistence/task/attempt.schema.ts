import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { CommitShaSchema, IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { VerificationSchema } from '@src/integration/persistence/task/verification.schema.ts';
import { EvaluationSchema } from '@src/integration/persistence/task/evaluation.schema.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

const BudgetExhaustedWarningSchema = z.object({
  kind: z.literal('budget-exhausted'),
  turnsUsed: z.number().int().nonnegative(),
  turnBudget: z.number().int().positive(),
});
const PlateauWarningSchema = z.object({
  kind: z.literal('plateau'),
  dimensions: z.array(z.string()).readonly(),
});
const MalformedWarningSchema = z.object({
  kind: z.literal('malformed'),
  detail: z.string(),
});
const VerifyFailedWarningSchema = z.object({
  kind: z.literal('verify-failed'),
  exitCode: z.number().int().nullable(),
  stderr: z.string(),
});
const AttemptWarningSchema = z.discriminatedUnion('kind', [
  BudgetExhaustedWarningSchema,
  PlateauWarningSchema,
  MalformedWarningSchema,
  VerifyFailedWarningSchema,
]);

const AttemptBaseShape = {
  n: z.number().int().positive(),
  startedAt: IsoTimestampSchema,
  verification: VerificationSchema.optional(),
  evaluation: EvaluationSchema.optional(),
  critique: z.string().optional(),
  commitSha: CommitShaSchema.optional(),
  sessionId: z.string().optional(),
  warning: AttemptWarningSchema.optional(),
};

const RunningAttemptSchema = z.object({
  ...AttemptBaseShape,
  status: z.literal('running'),
  finishedAt: z.null(),
});

const VerifiedAttemptSchema = z.object({
  ...AttemptBaseShape,
  status: z.literal('verified'),
  finishedAt: IsoTimestampSchema,
  verification: VerificationSchema,
});

const SettledFailedAttemptSchema = z.object({
  ...AttemptBaseShape,
  status: z.enum(['failed', 'malformed', 'aborted']),
  finishedAt: IsoTimestampSchema,
});

export const AttemptSchema = z.discriminatedUnion('status', [
  RunningAttemptSchema,
  VerifiedAttemptSchema,
  SettledFailedAttemptSchema,
]);

export const fromJsonAttempt = (input: unknown): Result<Attempt, ParseError> => safeParseToResult(AttemptSchema, input);

export const toJsonAttempt = (attempt: Attempt): unknown => attempt;

type _checkAttempt = Compatible<Attempt, z.infer<typeof AttemptSchema>>;
const _typeChecks: [_checkAttempt] = [true];
void _typeChecks;
