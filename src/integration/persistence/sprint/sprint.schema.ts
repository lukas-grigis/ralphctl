import { z } from 'zod';
import { type Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import {
  IsoTimestampSchema,
  ProjectIdSchema,
  SlugSchema,
  SprintIdSchema,
} from '@src/integration/persistence/shared/value-schemas.ts';
import { TicketSchema } from '@src/integration/persistence/sprint/ticket.schema.ts';
import { SPRINT_SCHEMA_VERSION, sprintMigrations } from '@src/integration/persistence/sprint/migrations.ts';
import { runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';
import { type Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

const SprintBaseShape = {
  id: SprintIdSchema,
  slug: SlugSchema,
  name: z.string(),
  tickets: z.array(TicketSchema).readonly(),
  projectId: ProjectIdSchema,
};

const DraftSprintSchema = z.object({
  ...SprintBaseShape,
  status: z.literal('draft'),
  plannedAt: z.null(),
  activatedAt: z.null(),
  reviewAt: z.null(),
  doneAt: z.null(),
});

const PlannedSprintSchema = z.object({
  ...SprintBaseShape,
  status: z.literal('planned'),
  plannedAt: IsoTimestampSchema,
  activatedAt: z.null(),
  reviewAt: z.null(),
  doneAt: z.null(),
});

const ActiveSprintSchema = z.object({
  ...SprintBaseShape,
  status: z.literal('active'),
  plannedAt: IsoTimestampSchema,
  activatedAt: IsoTimestampSchema,
  reviewAt: z.null(),
  doneAt: z.null(),
});

const ReviewSprintSchema = z.object({
  ...SprintBaseShape,
  status: z.literal('review'),
  plannedAt: IsoTimestampSchema,
  activatedAt: IsoTimestampSchema,
  reviewAt: IsoTimestampSchema,
  doneAt: z.null(),
});

const DoneSprintSchema = z.object({
  ...SprintBaseShape,
  status: z.literal('done'),
  plannedAt: IsoTimestampSchema,
  activatedAt: IsoTimestampSchema,
  reviewAt: IsoTimestampSchema,
  doneAt: IsoTimestampSchema,
});

/**
 * Sprint persistence schema. Each on-disk file also carries a top-level `schemaVersion`
 * field (silently ignored by `z.object` during parse since it is not declared on any
 * variant). The per-entity migration chain validates the version before parse.
 */
export const SprintSchema = z.discriminatedUnion('status', [
  DraftSprintSchema,
  PlannedSprintSchema,
  ActiveSprintSchema,
  ReviewSprintSchema,
  DoneSprintSchema,
]);

/**
 * Decode a persisted `sprint.json` payload. Walks the per-entity migration chain to
 * {@link SPRINT_SCHEMA_VERSION} and then Zod-parses against {@link SprintSchema}.
 */
export const fromJsonSprint = (
  input: unknown,
  filePath = 'sprint.json'
): Result<Sprint, MigrationGapError | ParseError> =>
  runMigrations<Sprint>(input, SPRINT_SCHEMA_VERSION, sprintMigrations, SprintSchema, filePath);

export const toJsonSprint = (sprint: Sprint): unknown => ({
  schemaVersion: SPRINT_SCHEMA_VERSION,
  ...sprint,
});

type _checkSprint = Compatible<Sprint, z.infer<typeof SprintSchema>>;
const _typeChecks: [_checkSprint] = [true];
void _typeChecks;
