import { Result } from 'typescript-result';

/**
 * A node in a dependency graph. `id` is the node's identity; `blockedBy` lists
 * the ids of nodes that must be ordered before this one. `item` is the
 * caller-owned payload returned in topological order.
 */
export interface DependencyNode<T> {
  readonly item: T;
  readonly id: string;
  readonly blockedBy: readonly string[];
}

/** A cycle was detected — the listed ids form a closed loop in the graph. */
export interface CycleError {
  readonly code: 'cycle';
  readonly cycle: readonly string[];
}

/** A `blockedBy` entry referenced an id that is not part of the input. */
export interface UnknownDepError {
  readonly code: 'unknown-dep';
  readonly from: string;
  readonly to: string;
}

export type DependencyReorderError = CycleError | UnknownDepError;

/**
 * Topologically sort the nodes so that every node appears AFTER all of its
 * `blockedBy` entries.
 *
 * Implementation: Kahn's algorithm with stable ordering — among nodes that
 * become "ready" simultaneously (in-degree zero), the original input order is
 * preserved. This makes the result deterministic and easy to reason about in
 * tests.
 *
 * Errors:
 * - `cycle` — at least one strongly-connected component of size ≥ 1 with a
 *   self/back edge prevents a complete topological order. The reported cycle
 *   walks back-edges from one of the unprocessed nodes until it revisits a
 *   member, so the returned ids form a closed loop.
 * - `unknown-dep` — a `blockedBy` entry refers to an id that is not present
 *   in the input. Surfaces graph-construction bugs early instead of silently
 *   ignoring the edge.
 */
export function topologicalReorder<T>(
  nodes: readonly DependencyNode<T>[]
): Result<readonly T[], DependencyReorderError> {
  if (nodes.length === 0) {
    return Result.ok([]);
  }

  // Index nodes by id, preserving original input order for stability.
  const byId = new Map<string, DependencyNode<T>>();
  const order = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    byId.set(node.id, node);
    order.set(node.id, i);
  }

  // Build adjacency: edge `from → to` means `from` must come before `to`,
  // i.e. `to` lists `from` in its blockedBy. Validate every blockedBy ref
  // exists; otherwise surface unknown-dep.
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of node.blockedBy) {
      if (!byId.has(dep)) {
        return Result.error({ code: 'unknown-dep', from: node.id, to: dep });
      }
      const fromList = outgoing.get(dep);
      if (fromList) fromList.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // Stable Kahn's: maintain a sorted-by-input-order ready queue. We rebuild
  // the candidate set each round and pick the lowest-input-index first; that
  // costs O(n²) in the worst case but the graphs we sort are small (sprint
  // tasks, not arbitrary DAGs) and stability beats raw speed here.
  const result: T[] = [];
  const ready: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) ready.push(node.id);
  }

  while (ready.length > 0) {
    // Pick the ready node with the smallest input index.
    let pickIndex = 0;
    for (let i = 1; i < ready.length; i++) {
      const candidate = ready[i];
      const current = ready[pickIndex];
      if (candidate === undefined || current === undefined) continue;
      if ((order.get(candidate) ?? 0) < (order.get(current) ?? 0)) {
        pickIndex = i;
      }
    }
    const id = ready.splice(pickIndex, 1)[0];
    if (id === undefined) break;
    const node = byId.get(id);
    if (!node) continue;
    result.push(node.item);

    for (const downstream of outgoing.get(id) ?? []) {
      const next = (inDegree.get(downstream) ?? 0) - 1;
      inDegree.set(downstream, next);
      if (next === 0) ready.push(downstream);
    }
  }

  if (result.length !== nodes.length) {
    // At least one node still has in-degree > 0 → there's a cycle. Walk
    // back-edges from any remaining node until we revisit a member to
    // produce a representative cycle.
    const remaining = new Set<string>();
    for (const node of nodes) {
      if ((inDegree.get(node.id) ?? 0) > 0) remaining.add(node.id);
    }
    const cycle = findCycle(remaining, byId);
    return Result.error({ code: 'cycle', cycle });
  }

  return Result.ok(result);
}

/**
 * Walk a node's blockedBy chain, restricted to the still-unprocessed set,
 * until a node is revisited. The slice from the first occurrence to the
 * revisit point is a cycle.
 */
function findCycle<T>(remaining: Set<string>, byId: Map<string, DependencyNode<T>>): string[] {
  const start = remaining.values().next().value;
  if (start === undefined) return [];

  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;

  while (current !== undefined) {
    if (seen.has(current)) {
      const idx = path.indexOf(current);
      return idx >= 0 ? path.slice(idx) : [current];
    }
    seen.add(current);
    path.push(current);

    const node = byId.get(current);
    if (!node) break;
    let next: string | undefined;
    for (const dep of node.blockedBy) {
      if (remaining.has(dep)) {
        next = dep;
        break;
      }
    }
    current = next;
  }

  return path;
}
