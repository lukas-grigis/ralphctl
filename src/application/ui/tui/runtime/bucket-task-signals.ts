/** Bucket the Implement chain's live state into a per-task view. */

import type { Trace, TraceStatus } from '@src/application/chain/trace.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';

/** UUIDv7 suffix on a per-task leaf name (`<leaf>-<36-char-uuid>`). */
export const UUID_SUFFIX_REGEX = /-([0-9a-fA-F-]{36})$/;
export const TOP_LEVEL_TASK_REGEX = /^task-[0-9a-fA-F-]{36}$/;

/** True when an element name belongs to a per-task subchain (top-level or any nested leaf). */
export const isPerTaskLeaf = (name: string): boolean => TOP_LEVEL_TASK_REGEX.test(name) || UUID_SUFFIX_REGEX.test(name);

/**
 * Default per-task subchain terminal substep — when this leaf appears for a task id, the task's overall status flips
 * to `completed`. Matches the implement flow.
 */
const DEFAULT_TERMINAL_SUBSTEP = 'uninstall-skills';

/** The per-task subchain's GUARDED BODY composite; a `skipped` body means the whole task is `blocked`. */
const BODY_SUBSTEP = 'task-body';

/**
 * `blocked` is a WHOLE-TASK bucket status, distinct from the per-substep `skipped` carried by {@link TraceStatus}: it
 * is emitted only when the dependency gate skipped the whole guarded body before any work ran.
 */
export type TaskBucketStatus = TraceStatus | 'running' | 'pending' | 'blocked';

export interface TaskSubStep {
  /** Leaf name with the task-id suffix stripped (e.g. `generator`, `commit-task`). */
  readonly leafName: string;
  readonly status: TraceStatus;
  readonly durationMs: number;
  readonly errorMessage?: string;
}

export interface TaskBucket {
  readonly id: string;
  readonly status: TaskBucketStatus;
  readonly durationMs?: number;
  readonly errorMessage?: string;
  readonly subSteps: readonly TaskSubStep[];
  readonly evaluations: readonly EvaluationSignal[];
  readonly signals: readonly HarnessSignal[];
  /** Number of gen-eval-loop iterations the task has entered. */
  readonly genEvalRound: number;
  /** Per-ATTEMPT cap for the gen-eval-loop (`maxTurns`), when known. Surfaced as `round N/M`. */
  readonly genEvalMaxRounds?: number;
  /** Configured cap on attempts per task (`maxAttempts`), when known. Surfaced as `attempt A/X`. */
  readonly genEvalMaxAttempts?: number;
  /** Live tracker-sourced attempt number as the budget counts it (free attempts left out). */
  readonly attemptN?: number;
  /** Live tracker-sourced 1-indexed round-within-attempt. Paired with {@link attemptN}. */
  readonly roundInAttempt?: number;
  readonly attemptResumed?: boolean;
}

export interface AttemptCoords {
  readonly attemptN: number;
  readonly roundInAttempt: number;
  readonly resumed?: boolean;
}

/**
 * Resolve a task bucket's round into attempt-relative display coordinates.
 * @public
 */
export const resolveAttemptCoords = (bucket: {
  readonly genEvalRound: number;
  readonly genEvalMaxRounds?: number;
  readonly attemptN?: number;
  readonly roundInAttempt?: number;
  readonly attemptResumed?: boolean;
}): AttemptCoords | undefined => {
  if (bucket.attemptN !== undefined && bucket.roundInAttempt !== undefined) {
    return {
      attemptN: bucket.attemptN,
      roundInAttempt: bucket.roundInAttempt,
      ...(bucket.attemptResumed === true ? { resumed: true } : {}),
    };
  }
  if (bucket.genEvalMaxRounds === undefined) return undefined;
  return perAttemptRound(bucket.genEvalRound, bucket.genEvalMaxRounds);
};

/**
 * Fold a task's monotonic gen-eval round into its per-attempt coordinates. {@link TaskBucket.genEvalRound} counts
 * across the whole task (the `rounds/` dir is shared).
 * @public
 */
export const perAttemptRound = (
  genEvalRound: number,
  maxTurns: number
): { readonly attemptN: number; readonly roundInAttempt: number } => {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || genEvalRound <= 0) {
    return { attemptN: 1, roundInAttempt: Math.max(1, genEvalRound) };
  }
  const zeroBased = genEvalRound - 1;
  return {
    attemptN: Math.floor(zeroBased / maxTurns) + 1,
    roundInAttempt: (zeroBased % maxTurns) + 1,
  };
};

export interface BucketedExecution {
  readonly tasks: readonly TaskBucket[];
  readonly orphanSignals: readonly HarnessSignal[];
}

interface TaskWindow {
  readonly startedAt: string;
  endedAt: string;
}

const taskIdFromInner = (name: string): string | undefined => {
  if (TOP_LEVEL_TASK_REGEX.test(name)) return undefined;
  const m = UUID_SUFFIX_REGEX.exec(name);
  return m?.[1];
};

const stripTaskSuffix = (name: string, taskId: string): string => {
  const tail = `-${taskId}`;
  return name.endsWith(tail) ? name.slice(0, -tail.length) : name;
};

/** Build per-task time windows from chain-step-completed events. */
const buildTaskWindows = (events: readonly AppEvent[]): { order: readonly string[]; byId: Map<string, TaskWindow> } => {
  const byId = new Map<string, TaskWindow>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type !== 'chain-step-completed' && e.type !== 'chain-step-failed') continue;
    const id = taskIdFromInner(e.elementName);
    if (id === undefined) continue;
    const at = String(e.at);
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, { startedAt: at, endedAt: at });
      order.push(id);
    } else {
      existing.endedAt = at;
    }
  }
  return { order, byId };
};

const collectSubSteps = (trace: Trace): Map<string, TaskSubStep[]> => {
  const byTask = new Map<string, TaskSubStep[]>();
  for (const entry of trace) {
    const taskId = taskIdFromInner(entry.elementName);
    if (taskId === undefined) continue;
    const sub: TaskSubStep = {
      leafName: stripTaskSuffix(entry.elementName, taskId),
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.error !== undefined ? { errorMessage: entry.error.message } : {}),
    };
    const list = byTask.get(taskId) ?? [];
    list.push(sub);
    byTask.set(taskId, list);
  }
  return byTask;
};

/** Per-task time-window for the signal-attribution binary-search. */
interface WindowEntry {
  readonly taskId: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * Binary-search the latest window with `startedAt <= ts`. Returns the index, or -1 when ts predates every window.
 */
const findOwningWindow = (sortedWindows: readonly WindowEntry[], ts: string): number => {
  let lo = 0;
  let hi = sortedWindows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedWindows[mid]!.startedAt <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
};

/**
 * Resolve a signal's owning taskId by the timestamp-window heuristic — the FALLBACK path, used only when the bus
 * entry carries no explicit `taskId` (see {@link bucketSignals}).
 */
const attributeByWindow = (ts: string, sortedWindows: readonly WindowEntry[]): string | undefined => {
  const idx = findOwningWindow(sortedWindows, ts);
  const candidate = idx >= 0 ? sortedWindows[idx] : undefined;
  return candidate !== undefined && ts <= candidate.endedAt ? candidate.taskId : undefined;
};

/**
 * O(signals + windows log windows) bucketing — replaced the original O(signals × windows) inner loop because
 * long-running sessions with high signal volume (1000+) made per-render bucketing a hot spot in the TUI.
 */
const bucketSignals = (
  entries: readonly SignalBusEntry[],
  windows: Map<string, TaskWindow>
): {
  signalsByTask: Map<string, HarnessSignal[]>;
  evaluationsByTask: Map<string, EvaluationSignal[]>;
  orphans: HarnessSignal[];
} => {
  const signalsByTask = new Map<string, HarnessSignal[]>();
  const evaluationsByTask = new Map<string, EvaluationSignal[]>();
  const orphans: HarnessSignal[] = [];

  const sortedWindows: WindowEntry[] = [...windows].map(([taskId, w]) => ({
    taskId,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
  }));
  sortedWindows.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  for (const entry of entries) {
    const sig = entry.signal;
    const owner = entry.taskId ?? attributeByWindow(String(sig.timestamp), sortedWindows);

    if (owner === undefined) {
      orphans.push(sig);
      continue;
    }
    if (sig.type === 'evaluation') {
      const list = evaluationsByTask.get(owner) ?? [];
      list.push(sig);
      evaluationsByTask.set(owner, list);
    } else {
      const list = signalsByTask.get(owner) ?? [];
      list.push(sig);
      signalsByTask.set(owner, list);
    }
  }
  return { signalsByTask, evaluationsByTask, orphans };
};

/** Derive the task-level status from its substep trace. See module docstring for the algorithm. */
const resolveStatusFromSubSteps = (subSteps: readonly TaskSubStep[], terminalSubstepName: string): TaskBucketStatus => {
  if (subSteps.length === 0) return 'pending';
  for (const sub of subSteps) {
    if (sub.status === 'aborted') return 'aborted';
    if (sub.status === 'failed') return 'failed';
  }
  if (subSteps.some((s) => s.leafName === BODY_SUBSTEP && s.status === 'skipped')) return 'blocked';
  const lastSeen = subSteps.some((s) => s.leafName === terminalSubstepName && s.status === 'completed');
  return lastSeen ? 'completed' : 'running';
};

/**
 * Is this bucket the one the operator is watching? `running` mid-task, `pending` in the brief transition window
 * between tasks.
 * @public
 */
export const isInFlightBucket = (bucket: { readonly status: TaskBucketStatus }): boolean =>
  bucket.status === 'running' || bucket.status === 'pending';

/**
 * The shape `unblockTask` (`domain/entity/task-lifecycle.ts`) leaves on a task that has already run: back on `todo`
 * with an empty live attempt ledger and the run it just cleared archived under `retiredAttempts`.
 */
const isRevivedAfterRun = (task: Task): boolean =>
  task.status === 'todo' && task.attempts.length === 0 && (task.retiredAttempts?.length ?? 0) > 0;

/**
 * The shape `unblockTask` leaves on a CASCADE dependent — a task blocked only because its prerequisite never
 * finished, not on its own merits.
 */
const isCascadeClearedTodo = (task: Task): boolean => task.status === 'todo' && task.attempts.length === 0;

/** Reconcile one trace-derived bucket with the polled entity sets. */
const reconcileBucket = (
  task: TaskBucket,
  blockedIds: ReadonlySet<string>,
  revivedIds: ReadonlySet<string>,
  cascadeClearedIds: ReadonlySet<string>
): TaskBucket => {
  if (task.status === 'failed' || task.status === 'aborted') return task;
  if (task.status === 'blocked') {
    if (!cascadeClearedIds.has(task.id)) return task;
    return { ...task, status: 'pending' };
  }
  if (blockedIds.has(task.id)) return { ...task, status: 'blocked' };
  if (task.status !== 'completed' || !revivedIds.has(task.id)) return task;
  // Drop the finished run's duration. On a pending card it would read as time spent waiting,
  // and `bucketTaskSignals` never puts a duration on a `pending` bucket either.
  const { durationMs: _finishedRunDuration, ...rest } = task;
  void _finishedRunDuration;
  return { ...rest, status: 'pending' };
};

/**
 * Correct the trace-only blind spot the module docstring names: a task blocked on its own merits (budget exhausted,
 * red post-task-verify, generator self-block) leaves an all-`completed` trace, so the polled entity status is
 * overlaid back onto the bucket. Returns the same object when nothing needed correcting.
 * @public
 */
export const overlayEntityBlockedStatus = (
  bucketed: BucketedExecution,
  taskState: readonly Task[] | undefined,
  isRunning: boolean
): BucketedExecution => {
  if (taskState === undefined || taskState.length === 0) return bucketed;
  const blockedIds = new Set<string>();
  const revivedIds = new Set<string>();
  const cascadeClearedIds = new Set<string>();
  for (const t of taskState) {
    if (t.status === 'blocked') blockedIds.add(String(t.id));
    else if (isRevivedAfterRun(t)) revivedIds.add(String(t.id));
    else if (!isRunning && isCascadeClearedTodo(t)) cascadeClearedIds.add(String(t.id));
  }
  if (blockedIds.size === 0 && revivedIds.size === 0 && cascadeClearedIds.size === 0) return bucketed;

  let changed = false;
  const tasks = bucketed.tasks.map((task) => {
    const reconciled = reconcileBucket(task, blockedIds, revivedIds, cascadeClearedIds);
    if (reconciled !== task) changed = true;
    return reconciled;
  });
  return changed ? { ...bucketed, tasks } : bucketed;
};

const firstFailureMessage = (subSteps: readonly TaskSubStep[]): string | undefined => {
  for (const sub of subSteps) {
    if ((sub.status === 'failed' || sub.status === 'aborted') && sub.errorMessage !== undefined) {
      return sub.errorMessage;
    }
  }
  return undefined;
};

const totalDurationMs = (subSteps: readonly TaskSubStep[]): number =>
  subSteps.reduce((sum, sub) => sum + (Number.isFinite(sub.durationMs) ? sub.durationMs : 0), 0);

const countGeneratorTurns = (subSteps: readonly TaskSubStep[]): number =>
  subSteps.reduce((n, sub) => (sub.leafName === 'generator' ? n + 1 : n), 0);

export interface BucketOptions {
  /** Configured cap on gen-eval-loop iterations per attempt (`config.harness.maxTurns`). */
  readonly maxTurns?: number;
  /**
   * Configured cap on attempts per task (`config.harness.maxAttempts`). Surfaced on each bucket as
   * `genEvalMaxAttempts` so the header / task-row can render `attempt A/X`.
   */
  readonly maxAttempts?: number;
  /**
   * Name of the per-task subchain's final leaf — when it appears in the trace the task flips to `completed`.
   */
  readonly terminalSubstepName?: string;
  /** Ids to show as `pending` before they have trace entries, so an early chain failure doesn't empty the panel. */
  readonly knownTaskIds?: readonly string[];
}

export const bucketTaskSignals = (
  trace: Trace,
  chainEvents: readonly AppEvent[],
  signals: readonly SignalBusEntry[],
  opts: BucketOptions = {}
): BucketedExecution => {
  const terminalSubstepName = opts.terminalSubstepName ?? DEFAULT_TERMINAL_SUBSTEP;
  const { order, byId: windows } = buildTaskWindows(chainEvents);
  const subStepsByTask = collectSubSteps(trace);
  const { signalsByTask, evaluationsByTask, orphans } = bucketSignals(signals, windows);

  // Append any known task ids that haven't traced yet so the panel shows pending rows instead of collapsing to the
  // "panel empty" state when a chain fails before per-task work starts. A Set keeps first-insertion order.
  const ids = [...new Set([...order, ...subStepsByTask.keys(), ...(opts.knownTaskIds ?? [])])];

  const tasks: TaskBucket[] = ids.map((id) => {
    const subSteps = subStepsByTask.get(id) ?? [];
    const status = resolveStatusFromSubSteps(subSteps, terminalSubstepName);
    const errorMessage = firstFailureMessage(subSteps);
    const duration =
      status === 'completed' || status === 'failed' || status === 'aborted' ? totalDurationMs(subSteps) : undefined;
    const genEvalRound = countGeneratorTurns(subSteps);
    return {
      id,
      status,
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      subSteps,
      evaluations: evaluationsByTask.get(id) ?? [],
      signals: signalsByTask.get(id) ?? [],
      genEvalRound,
      ...(opts.maxTurns !== undefined ? { genEvalMaxRounds: opts.maxTurns } : {}),
      ...(opts.maxAttempts !== undefined ? { genEvalMaxAttempts: opts.maxAttempts } : {}),
    };
  });

  return { tasks, orphanSignals: orphans };
};
