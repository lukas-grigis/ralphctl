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
const CrashedWarningSchema = z.object({
  kind: z.literal('crashed'),
  detail: z.string(),
});
const AttemptWarningSchema = z.discriminatedUnion('kind', [
  BudgetExhaustedWarningSchema,
  PlateauWarningSchema,
  MalformedWarningSchema,
  VerifyFailedWarningSchema,
  CrashedWarningSchema,
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
/**
 * Persistent shape of one {@link VerifyRun}. The audit row carries structured metadata only.
 * Pre-Wave-8 rows carried `stdoutTailBytes`; the per-entity migration chain strips that
 * field at load time (full output now lives at `<sprintDir>/logs/verify/<task-id>/...` per
 * audit-[01]).
 */
const VerifyRunSchema = z.object({
  phase: VerifyRunPhaseSchema,
  ranAt: IsoTimestampSchema,
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
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
  // Harness-side pre/post verify-script audit + derived attribution verdict. The pre-rename
  // `checkRuns` field is migrated to `verifyRuns` upstream by the per-entity tasks-file
  // migration chain (see `task/migrations.ts`), so this schema only sees the canonical key.
  verifyRuns: z.array(VerifyRunSchema).readonly().optional(),
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

export const AttemptSchema = z.discriminatedUnion('status', [
  RunningAttemptSchema,
  VerifiedAttemptSchema,
  SettledFailedAttemptSchema,
]);

export const fromJsonAttempt = (input: unknown): Result<Attempt, ParseError> => safeParseToResult(AttemptSchema, input);

type _checkAttempt = Compatible<Attempt, z.infer<typeof AttemptSchema>>;
const _typeChecks: [_checkAttempt] = [true];
void _typeChecks;
