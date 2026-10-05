/**
 * Pure projection of a flow's upfront plan tree against its live trace into the step display's
 * view model. Hierarchy comes from the plan's structure (kind, label, display metadata) — never
 * from element names — so every flow, including ones with per-task or per-ticket subtrees, goes
 * through the same rules. No React; the hook in `use-flow-progress.ts` only memoises it.
 */

import type { WorkItemRef } from '@src/application/chain/element.ts';
import type { PlanNode } from '@src/application/chain/plan-tree.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { StepStart, Trace } from '@src/application/chain/trace.ts';

export type StepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'aborted';

export interface RoundVerdict {
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly string[];
  readonly headline?: string;
}

/**
 * Verdict of one gen-eval round. `attemptN` is the enclosing attempt-loop iteration and `roundN`
 * the round-loop iteration within it (both 1-indexed), as the projection sees them.
 */
export type RoundVerdictLookup = (query: {
  readonly taskId: string;
  readonly attemptN: number;
  readonly roundN: number;
}) => RoundVerdict | undefined;

export interface StepView {
  readonly key: string;
  readonly label: string;
  readonly status: StepStatus;
  readonly depth: number;
  readonly durationMs?: number;
  readonly progress?: { readonly done: number; readonly total: number };
  readonly iteration?: { readonly n: number; readonly max?: number };
  /** Label of the hidden in-flight leaf this row is currently running. */
  readonly tail?: string;
  readonly errorMessage?: string;
  readonly verdict?: RoundVerdict;
  /** Every descendant leaf, hidden ones included. */
  readonly leafCount?: number;
  /** Visible leaf rows folded onto this row (a short loop body). */
  readonly inline?: readonly StepView[];
  /** Set on the `▴ k earlier` marker row that stands in for older finished iterations. */
  readonly earlier?: number;
  readonly children: readonly StepView[];
  readonly workItem?: WorkItemRef;
}

export interface FlowProgress {
  readonly spine: readonly StepView[];
  readonly activeSpineIndex: number | undefined;
  /** Work-item id → its (expanded as needed) subtree. */
  readonly workItems: ReadonlyMap<string, StepView>;
  readonly hasTaskWorkItems: boolean;
  readonly currentStep?: { readonly label: string; readonly workItemId?: string };
  readonly failure?: { readonly label: string; readonly workItemLabel?: string; readonly message?: string };
}

export interface FlowProgressInput {
  readonly plan: PlanNode;
  readonly trace: Trace;
  readonly inFlight: ReadonlyMap<string, StepStart>;
  readonly running: boolean;
  readonly awaiting: boolean;
  readonly verdicts?: RoundVerdictLookup;
}

import {
  allLeaves,
  applyRunningFallback,
  buildIndex,
  currentLeaves,
  evalNode,
  inferEvicted,
  type Ev,
} from '@src/application/ui/tui/runtime/flow-progress-eval.ts';

/** Finished loop iterations shown before older ones collapse into a `▴ k earlier` row. */
const MAX_FINISHED_ITERATIONS = 3;
const KEPT_FINISHED_ITERATIONS = 2;
/** Visible leaves a loop body may have and still render inline on its iteration row. */
const MAX_INLINE_LEAVES = 3;

// ---------------------------------------------------------------------------------------------
// Stage 2 — aggregate and project into views (R6-R14)
// ---------------------------------------------------------------------------------------------

const isTerminal = (s: StepStatus): boolean =>
  s === 'completed' || s === 'failed' || s === 'skipped' || s === 'aborted';

const aggregate = (leaves: readonly Ev[], sessionRunning: boolean): StepStatus => {
  const has = (s: StepStatus): boolean => leaves.some((l) => l.status === s);
  if (has('failed')) return 'failed';
  if (has('aborted')) return 'aborted';
  if (has('waiting')) return 'waiting';
  if (has('running')) return 'running';
  if (leaves.length === 0) return 'pending';
  const anyCompleted = has('completed');
  if (leaves.every((l) => isTerminal(l.status))) return anyCompleted ? 'completed' : 'skipped';
  // Between two steps nothing is in flight; a started composite still reads as running.
  return anyCompleted && sessionRunning ? 'running' : 'pending';
};

interface Build {
  readonly sessionRunning: boolean;
  readonly verdicts: RoundVerdictLookup | undefined;
  readonly workItems: Map<string, StepView>;
  readonly status: Map<Ev, StepStatus>;
  hasTask: boolean;
}

interface Scope {
  readonly path: string;
  readonly depth: number;
  readonly workItemId?: string;
  /** Iteration of the nearest enclosing loop inside the current work item. */
  readonly outerIteration?: number;
}

const statusOf = (ev: Ev, b: Build): StepStatus => {
  const cached = b.status.get(ev);
  if (cached !== undefined) return cached;
  const status = ev.node.kind === 'leaf' ? ev.status : aggregate(allLeaves(ev), b.sessionRunning);
  b.status.set(ev, status);
  return status;
};

const durationOf = (ev: Ev): number => allLeaves(ev).reduce((sum, l) => sum + l.durationMs, 0);
const labelOf = (node: PlanNode): string => node.label ?? node.name;
const isLeaf = (ev: Ev): boolean => ev.node.kind === 'leaf';
const isLoop = (ev: Ev): boolean => ev.node.kind === 'loop';
/** An unlabelled composite adds no row: its children lift into the parent. */
const isTransparent = (ev: Ev): boolean => !isLeaf(ev) && ev.node.label === undefined && ev.node.workItem === undefined;

const lift = (ev: Ev): Ev[] => (isTransparent(ev) ? liftAll(ev.children) : [ev]);
const liftAll = (evs: readonly Ev[]): Ev[] => evs.flatMap(lift);

const hiddenInternal = (ev: Ev, b: Build): boolean => {
  if (!ev.node.internal) return false;
  const s = statusOf(ev, b);
  return s !== 'failed' && s !== 'aborted';
};

const isHidden = (ev: Ev, depth: number, b: Build): boolean =>
  hiddenInternal(ev, b) || (depth >= 1 && statusOf(ev, b) === 'skipped');

const isActive = (s: StepStatus): boolean => s === 'running' || s === 'waiting';
const isExpanded = (s: StepStatus): boolean => isActive(s) || s === 'failed' || s === 'aborted';

const runningLeafLabel = (ev: Ev): string | undefined => {
  const leaf = allLeaves(ev).find((l) => isActive(l.status));
  return leaf === undefined ? undefined : labelOf(leaf.node);
};

const settledDuration = (status: StepStatus, ev: readonly Ev[]): { durationMs?: number } =>
  status === 'completed' || status === 'failed' || status === 'aborted'
    ? { durationMs: ev.reduce((sum, e) => sum + durationOf(e), 0) }
    : {};

const leafCount = (evs: readonly Ev[]): number => evs.reduce((n, e) => n + allLeaves(e).length, 0);

interface Built {
  readonly views: StepView[];
  readonly tail?: string;
}

const leafViews = new WeakSet<StepView>();

const leafView = (ev: Ev, b: Build, scope: Scope): StepView => {
  const status = statusOf(ev, b);
  const view: StepView = {
    key: `${scope.path}/${ev.node.name}`,
    label: labelOf(ev.node),
    status,
    depth: scope.depth,
    ...settledDuration(status, [ev]),
    ...((status === 'failed' || status === 'aborted') && ev.error !== undefined
      ? { errorMessage: ev.error.message }
      : {}),
    children: [],
  };
  leafViews.add(view);
  return view;
};

const syntheticView = (label: string, run: readonly Ev[], b: Build, scope: Scope): StepView => {
  const status = aggregate(
    run.flatMap((e) => allLeaves(e)),
    b.sessionRunning
  );
  const tail = isActive(status) ? run.map(runningLeafLabel).find((t) => t !== undefined) : undefined;
  return {
    key: `${scope.path}/${label.toLowerCase()}`,
    label,
    status,
    depth: scope.depth,
    ...settledDuration(status, run),
    leafCount: leafCount(run),
    ...(tail !== undefined ? { tail } : {}),
    children: [],
  };
};

/**
 * Turn a flat item list into rows. With `fold`, a leading run of hidden internal items becomes one
 * synthetic `Prepare` row and a trailing run one `Finish` row (spine and work-item roots only).
 */
/** Bounds of the items left after peeling the leading and trailing hidden-internal runs. */
const foldBounds = (items: readonly Ev[], b: Build): { start: number; end: number } => {
  let start = 0;
  let end = items.length;
  while (start < end && hiddenInternal(items[start]!, b)) start += 1;
  while (end > start && hiddenInternal(items[end - 1]!, b)) end -= 1;
  return { start, end };
};

const buildItems = (items: readonly Ev[], b: Build, scope: Scope, fold: boolean, raw = false): Built => {
  const { start, end } = fold && !raw ? foldBounds(items, b) : { start: 0, end: items.length };
  const views: StepView[] = [];
  const hiddenTails: string[] = [];
  if (start > 0) views.push(syntheticView('Prepare', items.slice(0, start), b, scope));
  for (const item of items.slice(start, end)) {
    if (raw || !isHidden(item, scope.depth, b)) {
      views.push(...viewsFor(item, b, scope));
    } else if (isActive(statusOf(item, b))) {
      hiddenTails.push(runningLeafLabel(item) ?? '');
    }
  }
  if (end < items.length) views.push(syntheticView('Finish', items.slice(end), b, scope));
  const tail = hiddenTails.find((t) => t !== '') ?? views.find((v) => v.tail !== undefined)?.tail;
  return { views, ...(tail !== undefined ? { tail } : {}) };
};

const collapse = (view: StepView, ev: readonly Ev[]): StepView =>
  isExpanded(view.status) ? view : { ...view, children: [], leafCount: leafCount(ev) };

const iterationVerdict = (n: number, b: Build, scope: Scope): RoundVerdict | undefined =>
  scope.workItemId !== undefined && scope.outerIteration !== undefined
    ? b.verdicts?.({ taskId: scope.workItemId, attemptN: scope.outerIteration, roundN: n })
    : undefined;

const loopViews = (ev: Ev, b: Build, scope: Scope): StepView[] => {
  const iters = ev.iters ?? [];
  const rows = iters.map((it, i): StepView => {
    const current = i === iters.length - 1;
    const leaves = it.children.flatMap((c) => allLeaves(c));
    const status = aggregate(leaves, b.sessionRunning);
    const inner: Scope = {
      ...scope,
      path: `${scope.path}/${ev.node.name}@${String(it.n)}`,
      depth: scope.depth + 1,
      outerIteration: it.n,
    };
    const verdict = iterationVerdict(it.n, b, scope);
    const base: StepView = {
      key: `${scope.path}/${ev.node.name}@${String(it.n)}`,
      label: labelOf(ev.node),
      status,
      depth: scope.depth,
      iteration: { n: it.n, ...(ev.node.maxIterations !== undefined ? { max: ev.node.maxIterations } : {}) },
      ...settledDuration(status, it.children),
      leafCount: leafCount(it.children),
      ...(verdict !== undefined ? { verdict } : {}),
      children: [],
    };
    if (!isExpanded(status) || (!current && status !== 'failed' && status !== 'aborted')) return base;
    const built = buildItems(liftAll(it.children), b, inner, false);
    const inlinable =
      status !== 'failed' &&
      status !== 'aborted' &&
      built.views.length > 0 &&
      built.views.length <= MAX_INLINE_LEAVES &&
      built.views.every((v) => leafViews.has(v));
    return {
      ...base,
      ...(built.tail !== undefined ? { tail: built.tail } : {}),
      ...(inlinable ? { inline: built.views } : { children: built.views }),
    };
  });
  const finished = rows.slice(0, -1);
  if (finished.length <= MAX_FINISHED_ITERATIONS) return rows;
  const dropped = finished.length - KEPT_FINISHED_ITERATIONS;
  const marker: StepView = {
    key: `${scope.path}/${ev.node.name}@earlier`,
    label: `${String(dropped)} earlier`,
    status: 'completed',
    depth: scope.depth,
    earlier: dropped,
    children: [],
  };
  return [marker, ...finished.slice(dropped), ...rows.slice(-1)];
};

/** Views for one non-transparent item (leaf, labelled composite, loop). */
const viewsFor = (ev: Ev, b: Build, scope: Scope): StepView[] => {
  if (isLeaf(ev)) return [leafView(ev, b, scope)];
  if (isLoop(ev)) return loopViews(ev, b, scope);

  const status = statusOf(ev, b);
  const path = `${scope.path}/${ev.node.name}`;
  const item = ev.node.workItem;
  const workItemId = item?.id ?? scope.workItemId;
  const inner: Scope = {
    path,
    depth: scope.depth + 1,
    ...(workItemId !== undefined ? { workItemId } : {}),
    ...(item === undefined && scope.outerIteration !== undefined ? { outerIteration: scope.outerIteration } : {}),
  };
  const items = liftAll(ev.children);
  const workRoots = items.filter((i) => i.node.workItem !== undefined);
  const base: StepView = {
    key: path,
    label: labelOf(ev.node),
    status,
    depth: scope.depth,
    ...settledDuration(status, [ev]),
    leafCount: allLeaves(ev).length,
    ...(item !== undefined ? { workItem: item } : {}),
    children: [],
  };

  if (workRoots.length > 0) {
    const kind = workRoots[0]!.node.workItem!.kind;
    if (kind === 'task') b.hasTask = true;
    const done = workRoots.filter((r) => {
      const s = statusOf(r, b);
      return s === 'completed' || s === 'skipped';
    }).length;
    const rest = items.filter((i) => i.node.workItem === undefined);
    // Task subtrees live in the Tasks panel; ticket rows expand in place.
    const roots = workRoots.flatMap((r) => viewsFor(r, b, inner));
    const others = buildItems(rest, b, inner, false).views;
    const children = kind === 'ticket' ? [...roots, ...others] : others;
    return [collapse({ ...base, progress: { done, total: workRoots.length }, children }, [ev])];
  }

  const built = buildItems(items, b, inner, item !== undefined);
  const view = collapse({ ...base, ...(built.tail !== undefined ? { tail: built.tail } : {}), children: built.views }, [
    ev,
  ]);
  if (item !== undefined) {
    if (item.kind === 'task') b.hasTask = true;
    b.workItems.set(item.id, view);
  }
  return [view];
};

// ---------------------------------------------------------------------------------------------
// currentStep / failure (R14)
// ---------------------------------------------------------------------------------------------

const deepestActive = (
  views: readonly StepView[],
  workItems: ReadonlyMap<string, StepView>,
  workItemId: string | undefined
): { label: string; workItemId?: string } | undefined => {
  const view = views.find((v) => isActive(v.status));
  if (view === undefined) return undefined;
  const id = view.workItem?.id ?? workItemId;
  const inlineActive = view.inline?.find((v) => isActive(v.status));
  if (inlineActive !== undefined) return { label: inlineActive.label, ...(id !== undefined ? { workItemId: id } : {}) };
  // A task fan-out row never expands: descend into the running task's own subtree.
  const kids =
    view.children.length > 0
      ? view.children
      : view.progress !== undefined
        ? [...workItems.values()].filter((w) => isActive(w.status))
        : [];
  const deeper = deepestActive(kids, workItems, id);
  if (deeper !== undefined) return deeper;
  return {
    label: view.tail !== undefined ? `${view.label} · ${view.tail}` : view.label,
    ...(id !== undefined ? { workItemId: id } : {}),
  };
};

const firstFailure = (ev: Ev, workItemLabel: string | undefined): FlowProgress['failure'] => {
  if (isLeaf(ev)) {
    if (ev.status !== 'failed') return undefined;
    return {
      label: labelOf(ev.node),
      ...(workItemLabel !== undefined ? { workItemLabel } : {}),
      ...(ev.error !== undefined ? { message: ev.error.message } : {}),
    };
  }
  const label = ev.node.workItem !== undefined ? labelOf(ev.node) : workItemLabel;
  const groups = ev.iters !== undefined ? ev.iters.map((it) => it.children) : [ev.children];
  for (const kids of groups) {
    for (const kid of kids) {
      const found = firstFailure(kid, label);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------

/** Unwrap single-child unlabelled composites from the root (`implement → with-repo-lock → implement-locked`). */
const spineItems = (root: Ev): Ev[] => {
  let node = root;
  let unwrapped = false;
  while (!isLeaf(node) && !isLoop(node) && node.node.label === undefined && node.children.length === 1) {
    node = node.children[0]!;
    unwrapped = true;
  }
  // A labelled step reached by unwrapping is itself the one main step; the root's own children are the spine.
  if (isLeaf(node) || isLoop(node) || (unwrapped && !isTransparent(node))) return [node];
  return liftAll(node.children);
};

export const projectFlowProgress = (input: FlowProgressInput): FlowProgress => {
  const index = buildIndex(input.trace, input.inFlight);
  const root = evalNode(input.plan, [], false, index);
  if (input.running && input.inFlight.size === 0) applyRunningFallback(root);
  inferEvicted(root);
  if (input.awaiting) for (const leaf of currentLeaves(root)) if (leaf.status === 'running') leaf.status = 'waiting';

  const b: Build = {
    sessionRunning: input.running,
    verdicts: input.verdicts,
    workItems: new Map(),
    status: new Map(),
    hasTask: false,
  };
  const scope: Scope = { path: input.plan.name, depth: 0 };
  const items = spineItems(root);
  let spine = buildItems(items, b, scope, true).views;
  if (spine.length === 0) spine = buildItems(items, b, scope, true, true).views;

  let activeSpineIndex: number | undefined = spine.findIndex((v) => isActive(v.status));
  if (activeSpineIndex < 0) activeSpineIndex = spine.findIndex((v) => v.status === 'failed' || v.status === 'aborted');
  if (activeSpineIndex < 0) activeSpineIndex = undefined;

  const currentStep = deepestActive(spine, b.workItems, undefined);
  const failure = firstFailure(root, undefined);
  return {
    spine,
    activeSpineIndex,
    workItems: b.workItems,
    hasTaskWorkItems: b.hasTask,
    ...(currentStep !== undefined ? { currentStep } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
};

/** Depth-ordered rows (parents before children) for the windowed list. */
export const flattenStepRows = (views: readonly StepView[]): readonly StepView[] =>
  views.flatMap((v) => [v, ...flattenStepRows(v.children)]);

/** Project a session descriptor; `undefined` when it has no plan tree. */
export const flowProgressOf = (
  descriptor: Pick<SessionDescriptor, 'planTree' | 'trace' | 'live' | 'status'>,
  awaiting: boolean,
  verdicts?: RoundVerdictLookup
): FlowProgress | undefined =>
  descriptor.planTree === undefined
    ? undefined
    : projectFlowProgress({
        plan: descriptor.planTree,
        trace: descriptor.trace,
        inFlight: descriptor.live?.inFlight ?? new Map(),
        running: descriptor.status === 'running',
        awaiting,
        ...(verdicts !== undefined ? { verdicts } : {}),
      });
