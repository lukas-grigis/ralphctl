/**
 * ctx-helpers — duck-typed context field extractors for the execute view.
 *
 * The execute view receives the runner's `ctx` as `unknown` to avoid a hard
 * import on the execute-chain's context types (and its surrounding dep tree).
 * These helpers duck-type the ctx shapes the view cares about.
 */

import type { TaskGridItem } from './task-execution-grid.tsx';

/**
 * Extract the full task list from the runner's chain context. Returns an
 * array of TaskGridItem when `ctx.tasks` is populated (after the
 * `load-tasks` step), or null otherwise (chain hasn't reached that step,
 * or this isn't an execute chain).
 */
export function getTaskList(ctx: unknown): readonly TaskGridItem[] | null {
  if (typeof ctx !== 'object' || ctx === null) return null;
  const tasks = (ctx as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const result: TaskGridItem[] = [];
  for (const t of tasks) {
    if (typeof t !== 'object' || t === null) continue;
    const id = (t as { id?: unknown }).id;
    const name = (t as { name?: unknown }).name;
    const status = (t as { status?: unknown }).status ?? 'todo';
    const blockedBy = (t as { blockedBy?: unknown }).blockedBy;
    const projectPath = (t as { projectPath?: unknown }).projectPath ?? '';
    const blockedReason = (t as { blockedReason?: unknown }).blockedReason;
    if (typeof id === 'string' && typeof name === 'string') {
      result.push({
        id,
        name,
        status: typeof status === 'string' ? status : 'todo',
        blockedBy: Array.isArray(blockedBy) ? blockedBy.filter((x): x is string => typeof x === 'string') : [],
        projectPath: typeof projectPath === 'string' ? projectPath : '',
        blockedReason: typeof blockedReason === 'string' ? blockedReason : undefined,
      });
    }
  }
  return result.length > 0 ? result : null;
}

/** Build an id → name map from the task list (for dep labels in TaskExecutionGrid). */
export function buildTaskNameLookup(tasks: readonly TaskGridItem[] | null): Map<string, string> | null {
  if (!tasks) return null;
  return new Map(tasks.map((t) => [t.id, t.name]));
}

/** Sprint id + cwd extraction from the runner's ExecuteCtx, for the feedback handoff. */
export function getExecuteCtxFields(ctx: unknown): { sprintId: string; cwd: string } | null {
  if (typeof ctx !== 'object' || ctx === null) return null;
  const c = ctx as { sprintId?: unknown; cwd?: unknown };
  if (typeof c.sprintId === 'string' && typeof c.cwd === 'string') {
    return { sprintId: c.sprintId, cwd: c.cwd };
  }
  return null;
}
