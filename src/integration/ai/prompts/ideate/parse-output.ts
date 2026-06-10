import { Result } from '@src/domain/result.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { parseTaskList } from '@src/integration/ai/prompts/_engine/parse-task-list.ts';
import { IdeateOutputSchema } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

/**
 * Parse the JSON the AI writes after an ideate session. Pure — no I/O.
 *
 * Validation runs in two stages: zod ({@link IdeateOutputSchema}) checks the envelope shape
 * and primitive types, then {@link parseTaskList} resolves domain references (projectPath →
 * Repository, blockedBy → TaskId) and constructs `TodoTask` entities. The fixed-ticket mode
 * stamps every task with the ideate-supplied `ticketId`.
 *
 * Schema (see `task-import-schema.ts`):
 *
 *     {
 *       "requirements": "## Problem ...",
 *       "tasks": [ TaskImportSpec, ... ]
 *     }
 */

export interface ParseIdeateOutputInput {
  readonly project: Project;
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
  /**
   * Optional source ticket — when supplied, its `externalRef` (if present) is inherited onto
   * every generated task as a single-element `externalRefs`. Callers that only have the id
   * (e.g. tests, legacy call-sites) can omit; the propagation then no-ops cleanly.
   */
  readonly ticket?: Ticket;
  /** Optional logger; forwarded to {@link parseTaskList} for the topological-reorder log line. */
  readonly logger?: Logger;
  /**
   * Default per-task attempt cap (`settings.harness.maxAttempts`) stamped onto every task.
   * Forwarded to {@link parseTaskList}; absent → no cap (parser-shape tests).
   */
  readonly defaultMaxAttempts?: number;
}

export interface ParseIdeateOutputResult {
  readonly requirements: string;
  readonly tasks: readonly TodoTask[];
}

export const parseIdeateOutput = (
  raw: string,
  ctx: ParseIdeateOutputInput
): Result<ParseIdeateOutputResult, ParseError> => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return Result.error(
      new ParseError({ subCode: 'invalid-json', message: 'ideate: AI output is not valid JSON', cause })
    );
  }

  const parsed = IdeateOutputSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.map((p) => String(p)).join('.') : '<root>';
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `ideate: ${path}: ${issue?.message ?? 'invalid shape'}`,
        cause: parsed.error,
      })
    );
  }

  const tasks = parseTaskList(parsed.data.tasks, {
    project: ctx.project,
    mode: { kind: 'fixed', ticketId: ctx.ticketId, ...(ctx.ticket !== undefined ? { ticket: ctx.ticket } : {}) },
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
    ...(ctx.defaultMaxAttempts !== undefined ? { defaultMaxAttempts: ctx.defaultMaxAttempts } : {}),
  });
  if (!tasks.ok) return Result.error(tasks.error);

  void ctx.sprintId; // sprintId travels via ticketId<->sprint linkage upstream.
  return Result.ok({ requirements: parsed.data.requirements, tasks: tasks.value });
};
