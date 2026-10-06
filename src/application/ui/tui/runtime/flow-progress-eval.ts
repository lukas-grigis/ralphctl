/**
 * Stage 1 of the flow-progress projection: evaluate the plan tree against the trace and the
 * in-flight starts into a mutable tree (scoped entry matching, composite skips, the running guess
 * and eviction inference). Pure; consumed only by `flow-progress.ts`.
 */

import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { LoopIteration, StepStart, Trace, TraceEntry } from '@src/application/chain/trace.ts';
import type { StepStatus } from '@src/application/ui/tui/runtime/flow-progress.ts';

export interface Ev {
  readonly node: PlanNode;
  status: StepStatus;
  /** A leaf has its own trace entry. */
  entry: boolean;
  durationMs: number;
  error: TraceEntry['error'];
  /** Current iteration's children for a loop. */
  children: Ev[];
  /** Every iteration of a loop, ascending; the last one is the current one. */
  iters?: IterEv[];
}

export interface IterEv {
  readonly n: number;
  readonly children: Ev[];
}

export interface Index {
  readonly byName: ReadonlyMap<string, readonly TraceEntry[]>;
  readonly inFlight: ReadonlyMap<string, StepStart>;
  /** loop name → every iteration stamp seen for it (entries and in-flight starts). */
  readonly loopStamps: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly iterations: readonly LoopIteration[]; readonly at: number }>
  >;
}

export const sameScope = (a: readonly LoopIteration[] | undefined, b: readonly LoopIteration[]): boolean => {
  const left = a ?? [];
  return left.length === b.length && left.every((it, i) => it.loop === b[i]?.loop && it.n === b[i]?.n);
};

export const buildIndex = (trace: Trace, inFlight: ReadonlyMap<string, StepStart>): Index => {
  const byName = new Map<string, TraceEntry[]>();
  const loopStamps = new Map<string, Array<{ iterations: readonly LoopIteration[]; at: number }>>();
  const stamp = (iterations: readonly LoopIteration[] | undefined): void => {
    iterations?.forEach((it, at) => {
      const list = loopStamps.get(it.loop) ?? [];
      list.push({ iterations, at });
      loopStamps.set(it.loop, list);
    });
  };
  for (const entry of trace) {
    const list = byName.get(entry.elementName) ?? [];
    list.push(entry);
    byName.set(entry.elementName, list);
    stamp(entry.iterations);
  }
  for (const start of inFlight.values()) stamp(start.iterations);
  return { byName, inFlight, loopStamps };
};

/** Iteration numbers observed for `loop` directly inside `scope`, ascending. */
export const observedIterations = (index: Index, loop: string, scope: readonly LoopIteration[]): number[] => {
  const seen = new Set<number>();
  for (const { iterations, at } of index.loopStamps.get(loop) ?? []) {
    if (at !== scope.length) continue;
    if (!sameScope(iterations.slice(0, at), scope)) continue;
    const n = iterations[at]?.n;
    if (n !== undefined) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
};

export const evalNode = (node: PlanNode, scope: readonly LoopIteration[], skipped: boolean, index: Index): Ev => {
  const ev: Ev = { node, status: 'pending', entry: false, durationMs: 0, error: undefined, children: [] };
  if (node.kind === 'leaf') {
    const entries = (index.byName.get(node.name) ?? []).filter((e) => sameScope(e.iterations, scope));
    const last = entries[entries.length - 1];
    if (last !== undefined) {
      ev.status = last.status;
      ev.entry = true;
      ev.durationMs = last.durationMs;
      ev.error = last.error;
    } else if (skipped) {
      ev.status = 'skipped';
    } else {
      const start = index.inFlight.get(node.name);
      if (start !== undefined && sameScope(start.iterations, scope)) ev.status = 'running';
    }
    return ev;
  }
  // A composite skip entry marks every descendant that has no entry of its own.
  const ownSkip = (index.byName.get(node.name) ?? []).some(
    (e) => e.status === 'skipped' && sameScope(e.iterations, scope)
  );
  const childSkipped = skipped || ownSkip;
  if (node.kind === 'loop') {
    const observed = observedIterations(index, node.name, scope);
    const current = observed.length > 0 ? (observed[observed.length - 1] ?? 1) : 1;
    const numbers = observed.includes(current) ? observed : [...observed, current];
    ev.iters = numbers.map((n) => ({
      n,
      children: node.children.map((c) => evalNode(c, [...scope, { loop: node.name, n }], childSkipped, index)),
    }));
    ev.children = ev.iters[ev.iters.length - 1]?.children ?? [];
    return ev;
  }
  ev.children = node.children.map((c) => evalNode(c, scope, childSkipped, index));
  return ev;
};

/** Leaves of the current iteration, in DFS order. */
export const currentLeaves = (ev: Ev, out: Ev[] = []): Ev[] => {
  if (ev.node.kind === 'leaf') out.push(ev);
  else for (const c of ev.children) currentLeaves(c, out);
  return out;
};

/** Leaves of every iteration of every loop beneath `ev`. */
export const allLeaves = (ev: Ev, out: Ev[] = []): Ev[] => {
  if (ev.node.kind === 'leaf') out.push(ev);
  else if (ev.iters !== undefined) for (const it of ev.iters) for (const c of it.children) allLeaves(c, out);
  else for (const c of ev.children) allLeaves(c, out);
  return out;
};

/** No in-flight data (a runner that never reported starts): guess the first untouched leaf after the last one with an entry. */
export const applyRunningFallback = (root: Ev): void => {
  const leaves = currentLeaves(root);
  if (leaves.some((l) => l.status === 'running')) return;
  let lastTouched = -1;
  leaves.forEach((l, i) => {
    if (l.entry) lastTouched = i;
  });
  const next = leaves.slice(lastTouched + 1).find((l) => l.status === 'pending');
  if (next !== undefined) next.status = 'running';
};

export const isTouched = (ev: Ev): boolean => allLeaves(ev).some((l) => l.entry || l.status === 'running');

const markPendingCompleted = (ev: Ev): void => {
  for (const leaf of allLeaves(ev)) if (leaf.status === 'pending') leaf.status = 'completed';
};

/** A work-item root, or an unlabelled single-child wrapper around one (a parallel worktree branch). */
const isWorkItemRoot = (ev: Ev): boolean =>
  ev.node.workItem !== undefined ||
  (ev.node.kind !== 'leaf' &&
    ev.node.label === undefined &&
    ev.children.length === 1 &&
    isWorkItemRoot(ev.children[0]!));

/** The trace ring evicts its head: untouched siblings before a touched one already ran. */
export const inferEvicted = (ev: Ev): void => {
  const groups: Ev[][] = ev.iters !== undefined ? ev.iters.map((it) => it.children) : [ev.children];
  for (const kids of groups) {
    const fanOut = kids.some(isWorkItemRoot);
    let lastTouched = -1;
    kids.forEach((k, i) => {
      if (isTouched(k)) lastTouched = i;
    });
    if (!fanOut) for (let i = 0; i < lastTouched; i += 1) markPendingCompleted(kids[i]!);
    for (const k of kids) if (k.node.kind !== 'leaf') inferEvicted(k);
  }
};
