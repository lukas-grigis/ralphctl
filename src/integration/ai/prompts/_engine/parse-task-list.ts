import { Result } from '@src/domain/result.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { TicketId as TicketIdValue } from '@src/domain/value/id/ticket-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { TaskImportListSchema, type TaskImportSpec } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';
import type { z } from 'zod';

type ZodIssueLike = z.core.$ZodIssue;

/**
 * Shared task-list parser used by interactive flows that produce tasks: ideate (combined
 * refine+plan) and plan-interactive (plan only). Pure — no I/O.
 *
 * Validates the JSON shape via {@link TaskImportListSchema} (zod), resolves `projectPath`
 * strings to `RepositoryId`, optionally validates `ticketRef` against a known ticket id set,
 * and constructs `TodoTask` entities with `ticketId` already attached.
 *
 * Two ticket-ref modes:
 *   - `'fixed'` — every task uses the same `ticketId` (ideate flow: one ticket per call).
 *   - `'lookup'` — task spec must include `ticketRef`; parser validates it against the
 *     supplied ticket id set (plan flow: tasks reference one of the sprint's approved
 *     tickets).
 */

/**
 * Public alias — type-level contract callers depend on. The runtime schema is in `task-import-schema.ts`.
 * @public
 */
export type TaskListSpec = TaskImportSpec;

export type ParseTaskListMode =
  | {
      readonly kind: 'fixed';
      readonly ticketId: TicketId;
      /**
       * Optional source ticket — when supplied the parser inherits `externalRef` onto every
       * generated task as a single-element `externalRefs`. Omit when the caller has no
       * ticket-level reference to propagate (e.g. tests that only care about task shape).
       */
      readonly ticket?: Ticket;
    }
  | {
      readonly kind: 'lookup';
      /**
       * Approved tickets the planner can map onto tasks. The parser validates each task's
       * `ticketRef` against this set (by id) and inherits the matched ticket's `externalRef`
       * onto the task as a single-element `externalRefs`.
       */
      readonly tickets: readonly Ticket[];
    };

export interface ParseTaskListInput {
  readonly project: Project;
  readonly mode: ParseTaskListMode;
}

export const parseTaskList = (
  rawTasks: unknown,
  input: ParseTaskListInput
): Result<readonly TodoTask[], ParseError> => {
  const parsed = TaskImportListSchema.safeParse(rawTasks);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task-list: ${formatZodIssue(parsed.error.issues)}`,
        cause: parsed.error,
      })
    );
  }
  const specs = parsed.data;

  const repoByPath = new Map<string, RepositoryId>();
  for (const repo of input.project.repositories) {
    repoByPath.set(String(repo.path), repo.id);
  }

  // Pass 1: resolve user-supplied task ids → minted TaskIds (for blockedBy resolution).
  const idMap = new Map<string, TaskId>();
  for (let i = 0; i < specs.length; i++) {
    const t = specs[i];
    if (t === undefined) continue;
    if (t.id !== undefined && t.id.trim().length > 0) {
      if (idMap.has(t.id)) {
        return Result.error(
          new ParseError({
            subCode: 'schema-mismatch',
            message: `task-list: duplicate task id '${t.id}' at index ${String(i)}`,
          })
        );
      }
      idMap.set(t.id, TaskId.generate());
    }
  }

  // Pass 2: domain-aware validation (path → repo, ticketRef → ticketId, blockedBy → TaskId)
  // and TodoTask construction.
  const tasks: TodoTask[] = [];
  for (let i = 0; i < specs.length; i++) {
    const t = specs[i];
    if (t === undefined) continue;

    const ticketResolution = resolveTicketRef(t, i, input.mode);
    if (!ticketResolution.ok) return Result.error(ticketResolution.error);
    const { ticketId, externalRefs } = ticketResolution.value;

    const repoId = repoByPath.get(t.projectPath);
    if (repoId === undefined) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task-list: tasks[${String(i)}].projectPath '${t.projectPath}' is not in the project's repositories`,
          hint: `available paths: ${Array.from(repoByPath.keys()).join(', ')}`,
        })
      );
    }
    const dependsOn: TaskId[] = [];
    for (const ref of t.blockedBy ?? []) {
      const resolved = idMap.get(ref);
      if (resolved === undefined) {
        return Result.error(
          new ParseError({
            subCode: 'schema-mismatch',
            message: `task-list: tasks[${String(i)}].blockedBy references unknown task id '${ref}'`,
          })
        );
      }
      dependsOn.push(resolved);
    }
    const mappedId = t.id !== undefined ? idMap.get(t.id) : undefined;
    // Normalise extras: trim, lowercase, drop empties so the prompt + parser stay stable
    // regardless of casing or stray whitespace the planner emits.
    const normalisedExtras =
      t.extraDimensions !== undefined
        ? t.extraDimensions.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0)
        : undefined;
    // `t.verificationCriteria` is the AI-emitted structured shape; pass it straight through —
    // `createTask` re-validates the auto / manual command invariant and clones defensively.
    const created = createTask({
      ...(mappedId !== undefined ? { id: mappedId } : {}),
      name: t.name,
      ...(t.description !== undefined && t.description.trim().length > 0 ? { description: t.description } : {}),
      steps: t.steps,
      verificationCriteria: t.verificationCriteria.map((c) => ({
        id: c.id,
        assertion: c.assertion,
        check: c.check,
        ...(c.command !== undefined ? { command: c.command } : {}),
      })),
      order: i + 1,
      ticketId,
      repositoryId: repoId,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(normalisedExtras !== undefined && normalisedExtras.length > 0 ? { extraDimensions: normalisedExtras } : {}),
      ...(externalRefs !== undefined ? { externalRefs } : {}),
    });
    if (!created.ok) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task-list: tasks[${String(i)}] failed validation: ${created.error.message}`,
          cause: created.error,
        })
      );
    }
    tasks.push(created.value);
  }

  return Result.ok(tasks);
};

interface ResolvedTicketRef {
  readonly ticketId: TicketId;
  /** Single-element when the source ticket carries an `externalRef`; `undefined` otherwise. */
  readonly externalRefs?: readonly string[];
}

const externalRefsOf = (ticket: Ticket | undefined): readonly string[] | undefined =>
  ticket?.externalRef !== undefined ? [ticket.externalRef] : undefined;

const resolveTicketRef = (
  t: TaskImportSpec,
  i: number,
  mode: ParseTaskListMode
): Result<ResolvedTicketRef, ParseError> => {
  if (mode.kind === 'fixed') {
    const externalRefs = externalRefsOf(mode.ticket);
    return Result.ok({ ticketId: mode.ticketId, ...(externalRefs !== undefined ? { externalRefs } : {}) });
  }
  if (typeof t.ticketRef !== 'string' || t.ticketRef.trim().length === 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task-list: tasks[${String(i)}].ticketRef missing — required when mode='lookup'`,
      })
    );
  }
  const ref = t.ticketRef;
  const match = mode.tickets.find((tk) => String(tk.id) === ref);
  if (match === undefined) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task-list: tasks[${String(i)}].ticketRef '${ref}' is not an approved ticket on the sprint`,
        hint: `available ticket ids: ${mode.tickets.map((tk) => String(tk.id)).join(', ')}`,
      })
    );
  }
  const parsed = TicketIdValue.parse(ref);
  if (!parsed.ok) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `task-list: tasks[${String(i)}].ticketRef '${ref}' is not a valid ticket id format`,
        cause: parsed.error,
      })
    );
  }
  const externalRefs = externalRefsOf(match);
  return Result.ok({ ticketId: parsed.value, ...(externalRefs !== undefined ? { externalRefs } : {}) });
};

/** Pull the first issue out of a zod error and format it `tasks[<n>].<field>: <message>`. */
const formatZodIssue = (issues: readonly ZodIssueLike[]): string => {
  const first = issues[0];
  if (first === undefined) return 'invalid task-list shape';
  const path = first.path.length === 0 ? '<root>' : first.path.map((p) => String(p)).join('.');
  return `${path}: ${first.message}`;
};
