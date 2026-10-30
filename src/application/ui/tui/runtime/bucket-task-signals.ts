/**
 * Bucket the Implement chain's live state into a per-task view from three inputs:
 *
 *  - `trace` — every leaf invocation with status + durationMs (no timestamps).
 *  - `chainEvents` — chain-step-completed / -failed events with ISO `at` timestamps.
 *  - `signals` — harness-signal bus entries, each with the signal's ISO timestamp plus an
 *    OPTIONAL explicit `taskId`.
 *
 * Per-task element names follow `<leaf>-<taskId>` (uuid v7), so inner leaves attribute by suffix.
 * Signal attribution is PRIMARY-then-FALLBACK: an explicit `taskId` (stamped only by the implement
 * flow's parallel per-branch publisher) wins; otherwise a signal belongs to the task whose
 * first-to-last-substep window contains its timestamp. Unattributed signals are `orphanSignals`.
 *
 * Status comes from the per-task substep trace alone (per-task composites emit no self-trace
 * entry, and in-flight starts live in the session's `live` map):
 *
 *  - any substep failed/aborted → that status (aborted wins)
 *  - the guarded body composite (`task-body-<id>`) recorded `skipped` → `blocked` (the dependency
 *    gate blocked the task upstream; distinct from a routinely skipped inner guard)
 *  - terminal leaf (`uninstall-skills-<id>`) recorded `completed` → `completed`
 *  - any other substep recorded → `running`; none → `pending`
 *
 * KNOWN BLIND SPOTS the trace cannot resolve, corrected by {@link overlayEntityBlockedStatus}
 * wherever a `BucketedExecution` drives a status-sensitive surface (card glyph, done/total count,
 * sidebar minimap):
 *
 *  - a task blocked on its OWN merits (budget exhausted, red post-task-verify, generator
 *    self-block) runs its whole subchain to the terminal leaf: `settleAttemptUseCase` records the
 *    block on the task ENTITY and returns ok so the chain continues — identical to a genuine pass.
 *  - a CASCADE dependent traces to `blocked` correctly, but once the operator unblocks its root,
 *    `unblockTaskUseCase` clears it to `todo`; while the run is live that is indistinguishable from
 *    the gate's own not-yet-polled block, so the trace verdict wins until the run settles.
 *
 * `bucketTaskSignals` stays pure and trace-only; empty inputs yield `{ tasks: [], orphanSignals: [] }`.
 */

import type { Trace, TraceStatus } from '@src/application/chain/trace.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { IMPLEMENT_TASK_TERMINAL_LEAF } from '@src/application/flows/implement/leaves/per-task-subchain.ts';

/** UUIDv7 suffix on a per-task leaf name (`<leaf>-<36-char-uuid>`). */
export const UUID_SUFFIX_REGEX = /-([0-9a-fA-F-]{36})$/;
export const TOP_LEVEL_TASK_REGEX = /^task-[0-9a-fA-F-]{36}$/;

/**
 * The per-task guarded BODY composite. `guard` emits one synthetic `skipped` entry named after its
 * body, so `task-body-<id>` `skipped` is the one unambiguous marker that a task never ran (guards
 * nested inside the body skip routinely on the happy path).
 */
const BODY_SUBSTEP = 'task-body';

/**
 * `blocked` is a WHOLE-TASK status, distinct from the per-substep `skipped` in {@link TraceStatus}:
 * emitted only when the guarded body composite itself was skipped (see {@link resolveStatusFromSubSteps}).
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
  /**
   * Number of gen-eval-loop iterations the task has entered. Counted from the number of
   * `generator-<taskId>` substep entries in the trace. 0 when no generator turn has happened
   * yet (e.g. task is still in branch-preflight / build-workspace).
   *
   * MONOTONIC ACROSS THE WHOLE TASK — the on-disk `rounds/<N>/` index is shared by every
   * attempt (`nextRoundNum = max(existing) + 1`), so attempt 2 continues numbering where
   * attempt 1 left off. Do NOT render this directly against {@link genEvalMaxRounds}: the cap
   * is per-ATTEMPT (`maxTurns`), so on a 2nd+ attempt the bare ratio overshoots (e.g. `4/3`).
   * Use {@link perAttemptRound} at render time to fold the monotonic round back into the
   * 1..maxTurns per-attempt window.
   */
  readonly genEvalRound: number;
  /** Per-ATTEMPT cap for the gen-eval-loop (`maxTurns`), when known. Surfaced as `round N/M`. */
  readonly genEvalMaxRounds?: number;
  /** Configured cap on attempts per task (`maxAttempts`), when known. Surfaced as `attempt A/X`. */
  readonly genEvalMaxAttempts?: number;
  /**
   * Live tracker-sourced 1-indexed attempt number (authoritative — straight off the
   * `task-round-started` event, see `use-task-round-tracker.ts`). Present ONLY when
   * `useBucketedTasks` has overlaid a tracked round; `bucketTaskSignals` itself never sets it (it
   * has no attempt information). A frozen-trace / no-live-events bucket (post-mortem replay) leaves
   * it undefined — {@link resolveAttemptCoords} then falls back to the division heuristic.
   */
  readonly attemptN?: number;
  /** Live tracker-sourced 1-indexed round-within-attempt. Paired with {@link attemptN}. */
  readonly roundInAttempt?: number;
  /** The live attempt resumes a free one — the chip appends `· resumed`. Paired with {@link attemptN}. */
  readonly attemptResumed?: boolean;
}

export interface AttemptCoords {
  readonly attemptN: number;
  readonly roundInAttempt: number;
  readonly resumed?: boolean;
}

/**
 * Resolve a task bucket's round into attempt-relative display coordinates. Prefers the live
 * tracker-sourced `attemptN`/`roundInAttempt` (authoritative — derived from the attempt boundary
 * in {@link "use-task-round-tracker.ts"}) when present. Falls back to the {@link perAttemptRound}
 * division heuristic ONLY when no live coordinates are available (e.g. a frozen-trace post-mortem
 * replay with no incoming events — see `use-bucketed-tasks.ts`'s docstring for why that fallback
 * must stay) and a `maxTurns` cap is known. Returns `undefined` when neither is available — callers
 * then render the bare round with no `/M` denominator and no attempt chip.
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
 * Fold a task's monotonic gen-eval round into its per-attempt coordinates. {@link TaskBucket.genEvalRound}
 * counts across the whole task (the `rounds/` dir is shared), while the loop's `maxTurns` cap resets each
 * attempt — so a naive `round/maxTurns` overshoots once a 2nd attempt starts (e.g. global round 4 with a
 * 3-turn budget reads `4/3`). This maps the global round back into `1..maxTurns` and derives which attempt
 * it belongs to.
 *
 * The derivation assumes each prior attempt ran its full `maxTurns` budget — the worst case, and exactly the
 * case where the overshoot bug surfaces. When an attempt stops early (the evaluator passes before `maxTurns`)
 * the attempt index is approximate, but `roundInAttempt` is always clamped to `1..maxTurns`, so the display
 * NEVER overshoots — the hard invariant this helper exists to guarantee.
 *
 * `maxTurns <= 0` (defensive — Zod clamps it to 1–10 upstream) collapses to `attempt 1 / round 1`.
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

/**
 * Per-task time windows from chain-step-completed events: earliest substep timestamp = start,
 * latest = end. Approximate (a signal between two substeps may attribute to either) but better
 * than orphaning everything. Insertion order is first-seen order.
 */
const buildTaskWindows = (events: readonly AppEvent[]): Map<string, TaskWindow> => {
  const windows = new Map<string, TaskWindow>();
  for (const e of events) {
    if (e.type !== 'chain-step-completed' && e.type !== 'chain-step-failed') continue;
    const id = taskIdFromInner(e.elementName);
    if (id === undefined) continue;
    const at = String(e.at);
    const existing = windows.get(id);
    if (existing === undefined) windows.set(id, { startedAt: at, endedAt: at });
    else existing.endedAt = at;
  }
  return windows;
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
    const list = byTask.get(taskId);
    if (list) list.push(sub);
    else byTask.set(taskId, [sub]);
  }
  return byTask;
};

/**
 * Group signal entries by owning taskId (`undefined` key = orphans). An entry's explicit `taskId`
 * is PRIMARY; the timestamp-window heuristic is the FALLBACK for every entry without one (the
 * implement serial path and every other flow). Tasks run sequentially so windows never overlap:
 * sort once by start and binary-search the latest window starting at or before each timestamp.
 */
const groupSignalsByOwner = (
  entries: readonly SignalBusEntry[],
  windows: ReadonlyMap<string, TaskWindow>
): Map<string | undefined, SignalBusEntry[]> => {
  const sorted = [...windows]
    .map(([taskId, w]) => ({ taskId, ...w }))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  const ownerByWindow = (ts: string): string | undefined => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.startedAt <= ts) lo = mid + 1;
      else hi = mid;
    }
    const candidate = sorted[lo - 1];
    return candidate !== undefined && ts <= candidate.endedAt ? candidate.taskId : undefined;
  };

  return Map.groupBy(entries, (entry) => entry.taskId ?? ownerByWindow(String(entry.signal.timestamp)));
};

/**
 * Derive the task-level status from its substep trace (see module doc). `failed` / `aborted` win
 * over later `completed` substeps. A `skipped` body composite resolves to `blocked`: the dependency
 * gate leaves no failed entry and no terminal leaf, so without this the task read `running` forever
 * and pinned the header's active-task cursor. The terminal leaf must have COMPLETED — a skipped one
 * never reads as finished.
 */
const resolveStatusFromSubSteps = (subSteps: readonly TaskSubStep[]): TaskBucketStatus => {
  if (subSteps.length === 0) return 'pending';
  for (const sub of subSteps) {
    if (sub.status === 'aborted') return 'aborted';
    if (sub.status === 'failed') return 'failed';
  }
  if (subSteps.some((s) => s.leafName === BODY_SUBSTEP && s.status === 'skipped')) return 'blocked';
  const finished = subSteps.some((s) => s.leafName === IMPLEMENT_TASK_TERMINAL_LEAF && s.status === 'completed');
  return finished ? 'completed' : 'running';
};

/**
 * Is this bucket the one the operator is watching? `running` mid-task, `pending` between tasks.
 * Settled buckets (including `blocked`) sit BEHIND the cursor, so a task blocked earlier in the list
 * never holds the header / Tasks-panel anchor while later tasks run.
 */
export const isInFlightBucket = (bucket: { readonly status: TaskBucketStatus }): boolean =>
  bucket.status === 'running' || bucket.status === 'pending';

/**
 * The shape `unblockTask` leaves on a task that already ran: `todo`, empty live attempts, the
 * cleared run archived under `retiredAttempts`. `todo` alone is not enough — a task fast enough to
 * finish between two polls can still show its pre-run `todo` (no retired run).
 */
const isRevivedAfterRun = (task: Task): boolean =>
  task.status === 'todo' && task.attempts.length === 0 && (task.retiredAttempts?.length ?? 0) > 0;

/**
 * The shape the unblock cascade leaves on a dependent that never ran: `todo` with empty attempts and
 * no archived run (so {@link isRevivedAfterRun} misses it). Safe to act on only once the run has
 * settled — while running it is indistinguishable from the dependency gate's not-yet-polled block.
 */
const isCascadeClearedTodo = (task: Task): boolean => task.status === 'todo' && task.attempts.length === 0;

/**
 * Reconcile one trace-derived bucket with the polled entity sets. Trace `failed`/`aborted` win
 * outright. Trace `blocked` wins too, unless the run has settled and the entity confirms a
 * cascade-clear — while running the gate decides far inside the poll lag, so a `todo` snapshot is
 * stale; once settled the frozen verdict is stale history and the entity is the only truth left.
 */
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
 * Overlay polled task-entity truth onto trace-derived buckets (the blind spots in the module doc).
 * For a bucket the trace says `completed`:
 *
 *  - entity `blocked` → `blocked` (also applied to a `running`/`pending` bucket)
 *  - entity `todo` after an unblock ({@link isRevivedAfterRun}) → `pending`
 *  - entity `in_progress` → trace wins; the poll lags the trace by up to 3 s and `unblockTask`
 *    never produces `in_progress`
 *  - entity `done` → trace wins
 *
 * A trace-`blocked` bucket reconciles to `pending` only once `isRunning` is false and the entity
 * shows a cascade-clear ({@link isCascadeClearedTodo}); right after a run settles a gate-blocked
 * task with a stale pre-run `todo` snapshot briefly renders `pending` too — the same accepted
 * window as {@link isRevivedAfterRun}. Trace `failed`/`aborted` are never touched.
 *
 * Pure and reference-stable: returns the SAME object when nothing needed correcting, so memoized
 * consumers don't re-render on every baseline-health poll tick.
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

const firstFailureMessage = (subSteps: readonly TaskSubStep[]): string | undefined =>
  subSteps.find((s) => (s.status === 'failed' || s.status === 'aborted') && s.errorMessage !== undefined)?.errorMessage;

const totalDurationMs = (subSteps: readonly TaskSubStep[]): number =>
  subSteps.reduce((sum, sub) => sum + (Number.isFinite(sub.durationMs) ? sub.durationMs : 0), 0);

export interface BucketOptions {
  /** Configured cap on gen-eval-loop iterations per attempt (`config.harness.maxTurns`). */
  readonly maxTurns?: number;
  /** Configured cap on attempts per task, surfaced as `genEvalMaxAttempts`; static config the round overlay leaves untouched. */
  readonly maxAttempts?: number;
  /**
   * Tasks known up front (e.g. from `tasks.json`): ids with no trace entries get `pending` buckets,
   * appended after traced tasks, so a chain failing before any per-task leaf (setup-script abort)
   * doesn't render the misleading "panel empty" state.
   */
  readonly knownTaskIds?: readonly string[];
}

export const bucketTaskSignals = (
  trace: Trace,
  chainEvents: readonly AppEvent[],
  signals: readonly SignalBusEntry[],
  opts: BucketOptions = {}
): BucketedExecution => {
  const windows = buildTaskWindows(chainEvents);
  const subStepsByTask = collectSubSteps(trace);
  const signalsByOwner = groupSignalsByOwner(signals, windows);
  const signalsOf = (owner: string | undefined): HarnessSignal[] =>
    (signalsByOwner.get(owner) ?? []).map((entry) => entry.signal);

  const ids = [...new Set([...windows.keys(), ...subStepsByTask.keys(), ...(opts.knownTaskIds ?? [])])];

  const tasks = ids.map((id): TaskBucket => {
    const subSteps = subStepsByTask.get(id) ?? [];
    const status = resolveStatusFromSubSteps(subSteps);
    const errorMessage = firstFailureMessage(subSteps);
    const owned = signalsOf(id);
    return {
      id,
      status,
      ...(status === 'completed' || status === 'failed' || status === 'aborted'
        ? { durationMs: totalDurationMs(subSteps) }
        : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      subSteps,
      evaluations: owned.filter((sig): sig is EvaluationSignal => sig.type === 'evaluation'),
      signals: owned.filter((sig) => sig.type !== 'evaluation'),
      genEvalRound: subSteps.filter((sub) => sub.leafName === 'generator').length,
      ...(opts.maxTurns !== undefined ? { genEvalMaxRounds: opts.maxTurns } : {}),
      ...(opts.maxAttempts !== undefined ? { genEvalMaxAttempts: opts.maxAttempts } : {}),
    };
  });

  return { tasks, orphanSignals: signalsOf(undefined) };
};
