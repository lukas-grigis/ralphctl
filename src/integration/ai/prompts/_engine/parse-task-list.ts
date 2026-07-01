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
import { renderTaskGraphIssue, scheduleIntoWaves } from '@src/domain/entity/task-graph.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { TaskImportListSchema, type TaskImportSpec } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';
import type { z } from 'zod';

type ZodIssueLike = z.core.$ZodIssue;

const SCHEMA_MISMATCH = 'schema-mismatch';

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
  /**
   * Optional logger — when supplied, the parser emits one `info` line iff the topological
   * reorder rearranged tasks vs the planner's emission order. Omitted in tests / callers that
   * don't observe the bus; behaviour is otherwise identical.
   */
  readonly logger?: Logger;
  /**
   * Default per-task attempt cap stamped onto every generated task — sourced from
   * `settings.harness.maxAttempts` by the plan / ideate flows. Carried on the task so the
   * gen-eval loop bounds attempts (`per-task-subchain` `maxIterations`), `failCurrentAttempt`
   * blocks the task once the budget is spent, and the escalation `budget-exhausted` branch can
   * fire — none of which engage while `task.maxAttempts` is undefined. Omitted in tests that
   * only assert task shape; absent → no cap stamped (legacy uncapped behaviour).
   */
  readonly defaultMaxAttempts?: number;
}

export const parseTaskList = (
  rawTasks: unknown,
  input: ParseTaskListInput
): Result<readonly TodoTask[], ParseError> => {
  const parsed = TaskImportListSchema.safeParse(rawTasks);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
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
  const idMapResult = buildIdMap(specs);
  if (!idMapResult.ok) return Result.error(idMapResult.error);
  const idMap = idMapResult.value;

  // Pass 2: domain-aware validation (path → repo, ticketRef → ticketId, blockedBy → TaskId)
  // and TodoTask construction.
  const tasks: TodoTask[] = [];
  for (let i = 0; i < specs.length; i++) {
    const t = specs[i];
    if (t === undefined) continue;

    const built = buildTask(t, i, {
      repoByPath,
      idMap,
      mode: input.mode,
      ...(input.defaultMaxAttempts !== undefined ? { defaultMaxAttempts: input.defaultMaxAttempts } : {}),
    });
    if (!built.ok) return Result.error(built.error);
    tasks.push(built.value);
  }

  // Pass 3: dependency-wave schedule via the shared domain scheduler.
  // `scheduleIntoWaves` validates the graph (unknown dep / self-edge / cycle) then runs
  // Kahn-by-level so every dependency lands in an earlier wave than its dependent. We flatten
  // the waves into a single sequence and renumber `order` to the 1-based array position.
  const scheduled = scheduleAndFlatten(tasks);
  if (!scheduled.ok) return Result.error(scheduled.error);
  if (scheduled.value.changed) {
    input.logger?.info(
      `[parseTaskList] reordered ${String(scheduled.value.tasks.length)} of ${String(tasks.length)} tasks to satisfy blockedBy graph`
    );
  }

  return Result.ok(scheduled.value.tasks);
};

/**
 * Pass 1 helper — mint a `TaskId` for every user-supplied `id` so Pass 2's `blockedBy`
 * resolution can look tasks up by their spec-authored id before the domain entity exists.
 * Rejects duplicate ids outright (the AI must not emit the same id twice within one call).
 */
const buildIdMap = (specs: readonly TaskImportSpec[]): Result<Map<string, TaskId>, ParseError> => {
  const idMap = new Map<string, TaskId>();
  for (let i = 0; i < specs.length; i++) {
    const t = specs[i];
    if (t === undefined) continue;
    if (t.id !== undefined && t.id.trim().length > 0) {
      if (idMap.has(t.id)) {
        return Result.error(
          new ParseError({
            subCode: SCHEMA_MISMATCH,
            message: `task-list: duplicate task id '${t.id}' at index ${String(i)}`,
          })
        );
      }
      idMap.set(t.id, TaskId.generate());
    }
  }
  return Result.ok(idMap);
};

/** Resolve a task's `blockedBy` spec-ids onto the minted `TaskId`s from {@link buildIdMap}. */
const resolveDependsOn = (
  blockedBy: readonly string[] | undefined,
  idMap: Map<string, TaskId>,
  i: number
): Result<TaskId[], ParseError> => {
  const dependsOn: TaskId[] = [];
  for (const ref of blockedBy ?? []) {
    const resolved = idMap.get(ref);
    if (resolved === undefined) {
      return Result.error(
        new ParseError({
          subCode: SCHEMA_MISMATCH,
          message: `task-list: tasks[${String(i)}].blockedBy references unknown task id '${ref}'`,
        })
      );
    }
    dependsOn.push(resolved);
  }
  return Result.ok(dependsOn);
};

/**
 * Normalise extras: trim, lowercase, drop empties so the prompt + parser stay stable regardless
 * of casing or stray whitespace the planner emits.
 */
const normalizeExtraDimensions = (extraDimensions?: readonly string[]): readonly string[] | undefined =>
  extraDimensions !== undefined
    ? extraDimensions.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0)
    : undefined;

/**
 * Pass 2 helper — resolve one task spec's cross-references (ticketRef → ticketId, projectPath →
 * repo, blockedBy → TaskId) and construct the `TodoTask` entity via `createTask`.
 * `t.verificationCriteria` is the AI-emitted structured shape; it is passed straight through —
 * `createTask` re-validates the auto / manual command invariant and clones defensively.
 */
const buildTask = (
  t: TaskImportSpec,
  i: number,
  ctx: {
    readonly repoByPath: Map<string, RepositoryId>;
    readonly idMap: Map<string, TaskId>;
    readonly mode: ParseTaskListMode;
    readonly defaultMaxAttempts?: number;
  }
): Result<TodoTask, ParseError> => {
  const ticketResolution = resolveTicketRef(t, i, ctx.mode);
  if (!ticketResolution.ok) return Result.error(ticketResolution.error);
  const { ticketId, externalRefs } = ticketResolution.value;

  const repoId = ctx.repoByPath.get(t.projectPath);
  if (repoId === undefined) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
        message: `task-list: tasks[${String(i)}].projectPath '${t.projectPath}' is not in the project's repositories`,
        hint: `available paths: ${Array.from(ctx.repoByPath.keys()).join(', ')}`,
      })
    );
  }

  const dependsOnResult = resolveDependsOn(t.blockedBy, ctx.idMap, i);
  if (!dependsOnResult.ok) return Result.error(dependsOnResult.error);
  const dependsOn = dependsOnResult.value;

  const mappedId = t.id !== undefined ? ctx.idMap.get(t.id) : undefined;
  const normalisedExtras = normalizeExtraDimensions(t.extraDimensions);

  const created = createTask({
    ...(mappedId !== undefined ? { id: mappedId } : {}),
    // Single-line names everywhere: the name is interpolated into the journal's structural
    // `## Task: <name> — Attempt <N>` header line that cap-progress splits and attributes on —
    // a planner-emitted newline would break the task's own section boundary.
    name: t.name.replace(/[\r\n\t\v\f]+/g, ' ').trim(),
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
    ...(ctx.defaultMaxAttempts !== undefined ? { maxAttempts: ctx.defaultMaxAttempts } : {}),
  });
  if (!created.ok) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
        message: `task-list: tasks[${String(i)}] failed validation: ${created.error.message}`,
        cause: created.error,
      })
    );
  }
  return Result.ok(created.value);
};

interface ScheduledTasks {
  readonly tasks: readonly TodoTask[];
  /** `true` iff the wave-flattened sequence differs from the input emission order. */
  readonly changed: boolean;
}

/**
 * Schedule tasks into dependency waves via the shared domain {@link scheduleIntoWaves}, then
 * flatten them into a single topologically-valid sequence. Every dependency lands in an earlier
 * wave than its dependent, so the flattened order satisfies every `dependsOn` edge. The
 * renumbered `order` field is rewritten to the post-flatten 1-based array position; persistence
 * and TUI rendering rely on that equality.
 *
 * Graph validity (unknown dependency / self-edge / cycle) is owned by `scheduleIntoWaves` →
 * `validateTaskGraph`; any {@link TaskGraphIssue} is mapped onto a `ParseError` here so the
 * integration boundary never leaks a domain error type upward.
 */
const scheduleAndFlatten = (tasks: readonly TodoTask[]): Result<ScheduledTasks, ParseError> => {
  if (tasks.length === 0) return Result.ok({ tasks, changed: false });

  const scheduled = scheduleIntoWaves(tasks);
  if (!scheduled.ok) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
        message: `task-list: ${renderTaskGraphIssue(scheduled.error)}`,
      })
    );
  }

  // Flatten waves into one sequence — wave order guarantees deps precede dependents. The
  // entities are the same `TodoTask` objects the parser constructed (status: 'todo'), so the
  // cast back to `TodoTask` is sound.
  const flattened = scheduled.value.flat() as readonly TodoTask[];

  // No-op detection: if the flattened sequence matches emission order task-for-task, return the
  // input unchanged so callers (and the reorder log) see a strict no-op.
  let changed = flattened.length !== tasks.length;
  if (!changed) {
    for (let i = 0; i < flattened.length; i++) {
      if (flattened[i]?.id !== tasks[i]?.id) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return Result.ok({ tasks, changed: false });

  // Renumber `order` to match the post-flatten 1-based position.
  const renumbered: TodoTask[] = flattened.map((task, newIdx) => ({ ...task, order: newIdx + 1 }));
  return Result.ok({ tasks: renumbered, changed: true });
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
        subCode: SCHEMA_MISMATCH,
        message: `task-list: tasks[${String(i)}].ticketRef missing — required when mode='lookup'`,
      })
    );
  }
  const ref = t.ticketRef;
  const match = mode.tickets.find((tk) => String(tk.id) === ref);
  if (match === undefined) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
        message: `task-list: tasks[${String(i)}].ticketRef '${ref}' is not an approved ticket on the sprint`,
        hint: `available ticket ids: ${mode.tickets.map((tk) => String(tk.id)).join(', ')}`,
      })
    );
  }
  const parsed = TicketIdValue.parse(ref);
  if (!parsed.ok) {
    return Result.error(
      new ParseError({
        subCode: SCHEMA_MISMATCH,
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
