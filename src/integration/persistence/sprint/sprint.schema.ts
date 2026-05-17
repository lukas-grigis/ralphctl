import { z } from 'zod';
import { type Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import {
  IsoTimestampSchema,
  ProjectIdSchema,
  SlugSchema,
  SprintIdSchema,
} from '@src/integration/persistence/shared/value-schemas.ts';
import { TicketSchema } from '@src/integration/persistence/sprint/ticket.schema.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

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

export const SprintSchema = z.discriminatedUnion('status', [
  DraftSprintSchema,
  PlannedSprintSchema,
  ActiveSprintSchema,
  ReviewSprintSchema,
  DoneSprintSchema,
]);

export const fromJsonSprint = (input: unknown): Result<Sprint, ParseError> => safeParseToResult(SprintSchema, input);

export const toJsonSprint = (sprint: Sprint): unknown => sprint;

type _checkSprint = Compatible<Sprint, z.infer<typeof SprintSchema>>;
const _typeChecks: [_checkSprint] = [true];
void _typeChecks;
