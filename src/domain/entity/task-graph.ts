import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';

/**
 * Walk the attempt history (newest → oldest) and return the most recent non-empty `critique`.
 *
 * Within a single attempt the loop's most recent evaluator turn stamps `critique` on the
 * running attempt; this query returns immediately on a match there. Across attempts (after a
 * crash + resume where `start-attempt` settles the prior running attempt as `aborted` and
 * opens a fresh one) the walk-back surfaces the prior aborted attempt's critique so the new
 * attempt's first generator turn starts with full context instead of cold.
 *
 * Returns `undefined` when no attempt has a non-empty critique — e.g. a brand-new task on its
 * very first turn, or a chain that crashed before any evaluator turn ran.
 */
export const latestCritique = (task: Task): string | undefined => {
  for (let i = task.attempts.length - 1; i >= 0; i--) {
    const att = task.attempts[i];
    if (att?.critique !== undefined && att.critique.trim().length > 0) return att.critique;
  }
  return undefined;
};

/**
 * Return the next task ready to execute: `todo` status, all `dependsOn` are `done`, picked by
 * lowest `order` to break ties deterministically. Returns `undefined` when nothing is ready
 * (either everything's done, or remaining todos are gated by unfinished deps / blocks).
 *
 * Pure — does not mutate. Caller persists the chosen task's `startNextAttempt` transition.
 */
export const nextAvailableTask = (tasks: readonly Task[]): Task | undefined => {
  const byId = new Map<TaskId, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const ready = tasks.filter((t) => {
    if (t.status !== 'todo') return false;
    return t.dependsOn.every((depId) => {
      const dep = byId.get(depId);
      return dep !== undefined && dep.status === 'done';
    });
  });

  if (ready.length === 0) return undefined;

  return ready.reduce((best, t) => (t.order < best.order ? t : best));
};

/** Issue surfaced by {@link validateTaskGraph}. */
export type TaskGraphIssue =
  | { readonly kind: 'unknown-dependency'; readonly task: TaskId; readonly missing: TaskId }
  | { readonly kind: 'self-edge'; readonly task: TaskId }
  | { readonly kind: 'cycle'; readonly cycle: readonly TaskId[] };

/**
 * Validate the dependency graph for a sprint's task set:
 *  - every `dependsOn` id resolves to a task in this set
 *  - no self-edges
 *  - no cycles (A → B → ... → A)
 *
 * Returns `Result.ok(undefined)` when sound, otherwise the first issue found.
 */
export const validateTaskGraph = (tasks: readonly Task[]): Result<undefined, TaskGraphIssue> => {
  const byId = new Map<TaskId, Task>();
  for (const t of tasks) byId.set(t.id, t);

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) return Result.error({ kind: 'self-edge', task: t.id });
      if (!byId.has(dep)) return Result.error({ kind: 'unknown-dependency', task: t.id, missing: dep });
    }
  }

  // DFS-based cycle detection. Colors: 0 = unseen, 1 = on current stack, 2 = fully explored.
  const color = new Map<TaskId, 0 | 1 | 2>();
  for (const t of tasks) color.set(t.id, 0);

  const stack: TaskId[] = [];
  const dfs = (id: TaskId): readonly TaskId[] | undefined => {
    color.set(id, 1);
    stack.push(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dep of node.dependsOn) {
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          const start = stack.indexOf(dep);
          return [...stack.slice(start), dep];
        }
        if (c === 0) {
          const cycle = dfs(dep);
          if (cycle !== undefined) return cycle;
        }
      }
    }
    stack.pop();
    color.set(id, 2);
    return undefined;
  };

  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const cycle = dfs(t.id);
      if (cycle !== undefined) return Result.error({ kind: 'cycle', cycle });
    }
  }

  return Result.ok(undefined);
};
