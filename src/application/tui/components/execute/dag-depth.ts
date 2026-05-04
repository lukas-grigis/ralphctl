/**
 * Pure DAG-depth helpers shared by the dependency-aware list and the layered
 * graph renderer in the execute view.
 *
 * A task's depth is `0` when it has no in-list dependencies, and
 * `1 + max(dep.depth)` otherwise. Depths are computed via memoised DFS;
 * cycles short-circuit to `null` so callers can fall back to insertion
 * order without crashing.
 */

export interface DagItem {
  readonly id: string;
  readonly blockedBy: readonly string[];
}

/**
 * Assign each task a depth. Returns `null` when a cycle is detected.
 */
export function computeDepths(tasks: readonly DagItem[]): Map<string, number> | null {
  const idSet = new Set(tasks.map((t) => t.id));
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    deps.set(
      t.id,
      t.blockedBy.filter((d) => idSet.has(d))
    );
  }

  const depths = new Map<string, number>();
  const inProgress = new Set<string>();

  function visit(id: string): number | null {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return null;
    inProgress.add(id);
    const taskDeps = deps.get(id) ?? [];
    let maxDepth = -1;
    for (const dep of taskDeps) {
      const d = visit(dep);
      if (d === null) {
        inProgress.delete(id);
        return null;
      }
      if (d > maxDepth) maxDepth = d;
    }
    inProgress.delete(id);
    const myDepth = maxDepth + 1;
    depths.set(id, myDepth);
    return myDepth;
  }

  for (const t of tasks) {
    if (visit(t.id) === null) return null;
  }
  return depths;
}

/**
 * Sort tasks by ascending depth, then by id within each layer for stable
 * ordering. Falls back to insertion order on cycles.
 */
export function sortByDepth<T extends DagItem>(tasks: readonly T[]): readonly T[] {
  const depths = computeDepths(tasks);
  if (depths === null) return [...tasks];
  return [...tasks].sort((a, b) => {
    const da = depths.get(a.id) ?? 0;
    const db = depths.get(b.id) ?? 0;
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Lookup helper that mirrors how the original grid read depths. */
export function getDepth(task: DagItem, depths: Map<string, number> | null): number {
  return depths?.get(task.id) ?? 0;
}
