import { z } from 'zod';
import { IsoTimestampSchema, RepositoryIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';

/**
 * Persistent shape of one {@link SetupRun}. The four-outcome union mirrors the domain enum so
 * downstream consumers (TUI baseline-health card) can render rich state without inferring
 * from `exitCode` alone — script-level failures and harness-level spawn errors look identical
 * by exit code (both non-zero) but mean very different things to the operator.
 *
 * The persisted shape carries structured metadata only. The full untruncated stdout/stderr
 * lives at `<sprintDir>/logs/setup/<repository-id>.log` per audit-[01]. Legacy on-disk rows
 * (pre-Wave 8) carried `stdoutTailBytes` / `stderrTailBytes` fields; the per-entity
 * migration chain strips them at load time so this schema only sees the post-Wave-8 shape.
 */
export const SetupRunSchema = z.object({
  repositoryId: RepositoryIdSchema,
  ranAt: IsoTimestampSchema,
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.union([z.literal('success'), z.literal('failed'), z.literal('spawn-error'), z.literal('skipped')]),
});
