import { z } from 'zod';

import { Task } from '@src/domain/entities/task.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';

const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'blocked']);
const evaluationStatusSchema = z.enum(['passed', 'failed', 'malformed']);

/**
 * On-disk shape of a single task. Lives alongside its sibling tasks under
 * `data/sprints/<id>/tasks.json`.
 */
export const taskJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()),
  verificationCriteria: z.array(z.string()),
  status: taskStatusSchema,
  order: z.number().int().positive(),
  ticketId: z.string().optional(),
  blockedBy: z.array(z.string()),
  projectPath: z.string(),
  verified: z.boolean(),
  verificationOutput: z.string().optional(),
  evaluated: z.boolean(),
  evaluationOutput: z.string().optional(),
  evaluationStatus: evaluationStatusSchema.optional(),
  evaluationFile: z.string().optional(),
  extraDimensions: z.array(z.string()).optional(),
  blockedReason: z.string().optional(),
});

export type TaskJson = z.infer<typeof taskJsonSchema>;

/** Container schema — the file holds the full ordered task list. */
export const taskListJsonSchema = z.array(taskJsonSchema);

/**
 * Convert a parsed `TaskJson` into a `Task` aggregate.
 *
 * Performance note: VOs read here come from a JSON file whose schema has
 * just been validated, so we use the `trustString` escape hatch to skip
 * re-validation. If the value-object format ever drifts behind the file
 * format, the cheapest fix is to flip these to `parse` calls and pay the
 * extra ~µs per task.
 */
export function toTask(parsed: TaskJson): Result<Task, StorageError> {
  const id = TaskId.trustString(parsed.id);
  const projectPath = AbsolutePath.trustString(parsed.projectPath);
  const blockedBy = parsed.blockedBy.map((b) => TaskId.trustString(b));
  const ticketId = parsed.ticketId !== undefined ? TicketId.trustString(parsed.ticketId) : undefined;
  const extraDimensions = parsed.extraDimensions;

  // Re-create through the entity factory so default invariants are enforced.
  // The `Task.create` factory always returns a fresh task in `todo` status —
  // we then promote the runtime fields (status, verified, evaluated, …) on
  // top through state methods + private rehydration via deserialise.
  const created = Task.create({
    id,
    name: parsed.name,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    steps: parsed.steps,
    verificationCriteria: parsed.verificationCriteria,
    order: parsed.order,
    ...(ticketId !== undefined ? { ticketId } : {}),
    blockedBy,
    projectPath,
    ...(extraDimensions !== undefined ? { extraDimensions } : {}),
  });
  if (!created.ok) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `task '${parsed.id}' failed entity validation: ${created.error.message}`,
        cause: created.error,
      })
    );
  }
  let task = created.value;

  // Lift runtime state on top of the fresh aggregate. Status transitions
  // bypass the entity guards because the on-disk value is authoritative —
  // the state machine has already validated this at write time.
  task = rehydrate(task, parsed);
  return Result.ok(task);
}

/** Reverse direction — domain entity → JSON-shaped object. */
export function fromTask(task: Task): TaskJson {
  return {
    id: task.id,
    name: task.name,
    ...(task.description !== undefined ? { description: task.description } : {}),
    steps: [...task.steps],
    verificationCriteria: [...task.verificationCriteria],
    status: task.status,
    order: task.order,
    ...(task.ticketId !== undefined ? { ticketId: task.ticketId } : {}),
    blockedBy: [...task.blockedBy],
    projectPath: task.projectPath,
    verified: task.verified,
    ...(task.verificationOutput !== undefined ? { verificationOutput: task.verificationOutput } : {}),
    evaluated: task.evaluated,
    ...(task.evaluationOutput !== undefined ? { evaluationOutput: task.evaluationOutput } : {}),
    ...(task.evaluationStatus !== undefined ? { evaluationStatus: task.evaluationStatus } : {}),
    ...(task.evaluationFile !== undefined ? { evaluationFile: task.evaluationFile } : {}),
    ...(task.extraDimensions !== undefined ? { extraDimensions: [...task.extraDimensions] } : {}),
    ...(task.blockedReason !== undefined ? { blockedReason: task.blockedReason } : {}),
  };
}

/**
 * Rebuild a Task with persisted runtime fields (status, verified flags, …)
 * — the state machine on the entity rejects invalid jumps, but on rehydrate
 * we already know the persisted state is valid (it was produced by a prior
 * write that went through the same machine).
 *
 * We achieve this by walking the linear status path forward to whatever
 * state the JSON encodes, then layering verification/evaluation in by
 * calling the `record*` methods directly.
 */
function rehydrate(base: Task, parsed: TaskJson): Task {
  let t = base;
  // Walk the linear status path forward to whatever state was persisted.
  // For `blocked` we always pass through `todo` (the create factory's
  // default), then call `markBlocked` with the persisted reason.
  if (parsed.status === 'in_progress' || parsed.status === 'done') {
    const r = t.markInProgress();
    if (r.ok) t = r.value;
  }
  if (parsed.status === 'done') {
    const r = t.markDone();
    if (r.ok) t = r.value;
  }
  if (parsed.status === 'blocked') {
    // `blockedReason` may be missing on legacy on-disk records; fall back
    // to a placeholder rather than refusing to rehydrate.
    const reason = parsed.blockedReason ?? '';
    const r = t.markBlocked(reason);
    if (r.ok) t = r.value;
  }
  if (parsed.verified && parsed.verificationOutput !== undefined) {
    t = t.recordVerification(parsed.verificationOutput);
  } else if (parsed.verified) {
    t = t.recordVerification('');
  }
  if (
    parsed.evaluated &&
    parsed.evaluationOutput !== undefined &&
    parsed.evaluationStatus !== undefined &&
    parsed.evaluationFile !== undefined
  ) {
    t = t.recordEvaluation({
      output: parsed.evaluationOutput,
      status: parsed.evaluationStatus,
      file: parsed.evaluationFile,
    });
  }
  return t;
}
