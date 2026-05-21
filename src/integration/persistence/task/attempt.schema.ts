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

const AbortCauseSchema = z.enum([
  'user-cancel',
  'sigterm',
  'watchdog-killed',
  'rate-limit-exhausted',
  'process-crash',
  'unknown',
]);

const RecoveryContextSchema = z.object({
  fromAttemptN: z.number().int().positive(),
  cause: AbortCauseSchema,
  abortedAt: IsoTimestampSchema,
});

const VerifyRunOutcomeSchema = z.enum(['success', 'failed', 'spawn-error', 'skipped']);
const VerifyRunPhaseSchema = z.enum(['pre', 'post']);
const VerifyRunSchema = z.object({
  phase: VerifyRunPhaseSchema,
  ranAt: IsoTimestampSchema,
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdoutTailBytes: z.string(),
  outcome: VerifyRunOutcomeSchema,
});
const AttributionSchema = z.enum(['clean', 'regressed', 'baseline-broken', 'fixed-baseline']);

const AttemptBaseShape = {
  n: z.number().int().positive(),
  startedAt: IsoTimestampSchema,
  verification: VerificationSchema.optional(),
  evaluation: EvaluationSchema.optional(),
  critique: z.string().optional(),
  commitSha: CommitShaSchema.optional(),
  sessionId: z.string().optional(),
  warning: AttemptWarningSchema.optional(),
  // Aborted-attempt forensics. Stored on every attempt variant for schema symmetry —
  // semantically only populated on `status === 'aborted'` records (see attempt.ts).
  abortCause: AbortCauseSchema.optional(),
  signalOrExitCode: z.union([z.string(), z.number()]).optional(),
  // Set at attempt creation time when opening as a resume of a prior aborted attempt.
  recovering: RecoveryContextSchema.optional(),
  // Harness-side pre/post verify-script audit + derived attribution verdict. The `checkRuns`
  // alias accepts on-disk records persisted before the v0.7.0 verify rename; it is dropped at
  // the boundary and only `verifyRuns` flows into the domain.
  verifyRuns: z.array(VerifyRunSchema).readonly().optional(),
  checkRuns: z.array(VerifyRunSchema).readonly().optional(),
  attribution: AttributionSchema.optional(),
  baselineBroken: z.boolean().optional(),
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

/**
 * Discriminated-union schema with a post-parse legacy-field migration: if an on-disk record
 * carried the pre-rename `checkRuns` array (and no `verifyRuns`), lift it to `verifyRuns` and
 * drop the legacy key so the rest of the codebase sees a clean entity.
 */
export const AttemptSchema = z
  .discriminatedUnion('status', [RunningAttemptSchema, VerifiedAttemptSchema, SettledFailedAttemptSchema])
  .transform((att) => {
    const { checkRuns, verifyRuns, ...rest } = att;
    const runs = verifyRuns ?? checkRuns;
    return {
      ...rest,
      ...(runs !== undefined ? { verifyRuns: runs } : {}),
    };
  });

export const fromJsonAttempt = (input: unknown): Result<Attempt, ParseError> => safeParseToResult(AttemptSchema, input);

type _checkAttempt = Compatible<Attempt, z.infer<typeof AttemptSchema>>;
const _typeChecks: [_checkAttempt] = [true];
void _typeChecks;
