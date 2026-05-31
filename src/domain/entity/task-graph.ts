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
 *
 * NOTE — the error channel is the {@link TaskGraphIssue} discriminated union, NOT a `DomainError`,
 * which is deliberate (the only domain function that does so). A graph fault isn't a single
 * error type: each kind carries structured fields the two callers render differently
 * (`parseTaskList` folds the issue into a `ParseError` message via {@link renderTaskGraphIssue};
 * `resolveImplementQueue` surfaces it as a `TaskGraphIssue` the launcher renders inline). Picking a
 * concrete `DomainError` here would force one caller to re-parse a flattened message to recover the
 * structure — so the structured union stays the contract and each caller maps it onto its own error
 * envelope. This is not an oversight.
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

/**
 * Render a {@link TaskGraphIssue} as a single human-readable line. Pure — used by callers
 * that surface the issue through their own error envelope (e.g. the parser maps it onto a
 * `ParseError` message). Kept here so the wording stays adjacent to the issue shape it
 * describes and both producers and consumers share one phrasing.
 *
 * @public
 */
export const renderTaskGraphIssue = (issue: TaskGraphIssue): string => {
  switch (issue.kind) {
    case 'unknown-dependency':
      return `task ${issue.task} depends on unknown task ${issue.missing}`;
    case 'self-edge':
      return `task ${issue.task} depends on itself`;
    case 'cycle':
      return `dependency cycle: ${issue.cycle.join(' → ')}`;
  }
};

/**
 * Schedule a sprint's task set into dependency waves for parallel execution.
 *
 * Validates the graph first via {@link validateTaskGraph}; any {@link TaskGraphIssue}
 * (unknown dependency, self-edge, cycle) short-circuits and propagates unchanged. On a sound
 * DAG, runs Kahn's algorithm by level:
 *  - wave 0 = every in-degree-0 node (no `dependsOn`), sorted by `Task.order` ASC;
 *  - decrement the in-degree of each scheduled node's successors;
 *  - the next wave = all nodes whose in-degree just hit 0, again sorted by `order` ASC;
 *  - repeat until every node is scheduled.
 *
 * Each returned wave is internally independent — no task in a wave depends on another in the
 * same wave — so the launcher can run a wave's tasks concurrently. Waves are strictly ordered:
 * every dependency of a task in wave `k` was scheduled in some wave `< k`.
 *
 * Empty input yields an empty schedule. Pure — no mutation of inputs, no I/O.
 *
 * @public
 */
/**
 * Build the in-degree counts + successor adjacency for Kahn's algorithm. In-degree is the
 * count of a task's dependencies that resolve to a task in this set; `validateTaskGraph`
 * already guarantees every `dependsOn` id resolves, so the `byId.has` filter is belt-and-braces.
 */
const buildGraph = (
  tasks: readonly Task[],
  byId: ReadonlyMap<TaskId, Task>
): { readonly inDegree: Map<TaskId, number>; readonly successors: ReadonlyMap<TaskId, TaskId[]> } => {
  const inDegree = new Map<TaskId, number>();
  const successors = new Map<TaskId, TaskId[]>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    successors.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) continue;
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      successors.get(dep)?.push(t.id);
    }
  }
  return { inDegree, successors };
};

export const scheduleIntoWaves = (tasks: readonly Task[]): Result<ReadonlyArray<readonly Task[]>, TaskGraphIssue> => {
  const validation = validateTaskGraph(tasks);
  if (!validation.ok) return Result.error(validation.error);

  const byId = new Map<TaskId, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const { inDegree, successors } = buildGraph(tasks, byId);
  const byOrderAsc = (a: Task, b: Task): number => a.order - b.order;

  const waves: Task[][] = [];
  let frontier = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0).sort(byOrderAsc);

  while (frontier.length > 0) {
    waves.push(frontier);
    const next: Task[] = [];
    for (const t of frontier) {
      for (const succId of successors.get(t.id) ?? []) {
        const remaining = (inDegree.get(succId) ?? 0) - 1;
        inDegree.set(succId, remaining);
        const succ = byId.get(succId);
        if (remaining === 0 && succ !== undefined) next.push(succ);
      }
    }
    frontier = next.sort(byOrderAsc);
  }

  return Result.ok(waves);
};
