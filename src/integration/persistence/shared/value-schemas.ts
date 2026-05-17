import { z } from 'zod';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { CommitSha } from '@src/domain/value/commit-sha.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import type { HttpUrl } from '@src/domain/value/http-url.ts';

/**
 * Zod schemas for branded value objects. Each delegates to the existing `.parse(unknown)`
 * factory so validation rules live in exactly one place — adding a new constraint to a value
 * object's regex flows here automatically.
 *
 * Output type is the branded type (via the trailing `.transform`), so `z.infer` correctly
 * narrows nested aggregate schemas without any manual casts at call sites.
 */

/** Wraps a `parse(unknown): Result<T, ValidationError>` factory into a branded zod schema. */
const brandedString = <T extends string>(
  factory: (input: unknown) => { ok: true; value: T } | { ok: false; error: { message: string } }
) =>
  z
    .string()
    .superRefine((s, ctx) => {
      const r = factory(s);
      if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error.message });
    })
    .transform((s) => s as T);

export const SlugSchema = brandedString(Slug.parse);
export const ProjectIdSchema = brandedString(ProjectId.parse);
export const RepositoryIdSchema = brandedString(RepositoryId.parse);
export const SprintIdSchema = brandedString(SprintId.parse);
export const TaskIdSchema = brandedString(TaskId.parse);
export const TicketIdSchema = brandedString(TicketId.parse);
export const IsoTimestampSchema = brandedString(IsoTimestamp.parse);
export const AbsolutePathSchema = brandedString(AbsolutePath.parse);
export const CommitShaSchema = brandedString(CommitSha.parse);

/** HttpUrl is parsed by a free function, not a `.parse` factory — wire it the same way. */
export const HttpUrlSchema = z
  .string()
  .superRefine((s, ctx) => {
    const r = parseHttpUrl('http-url', s);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error.message });
  })
  .transform((s) => s as HttpUrl);
