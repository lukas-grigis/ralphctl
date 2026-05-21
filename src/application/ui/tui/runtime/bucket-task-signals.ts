/**
 * Bucket the Implement chain's live state into a per-task view. Three inputs collide here:
 *
 *  - `trace` — every leaf invocation with status + durationMs (no timestamps).
 *  - `chainEvents` — the chain-step-completed events with ISO `at` timestamps (the chain
 *    runner bridge only emits `chain-step-completed` / `chain-step-failed`, never `-started`).
 *  - `signals` — harness signals (change/learning/decision/evaluation/…); each carries an
 *    ISO timestamp but no task id.
 *
 * Per-task element names follow `<leaf>-<taskId>` (uuid v7 36-char). Inner leaves attribute
 * trivially by suffix. Signals attribute by timestamp: a signal belongs to the task whose
 * first-substep-to-last-substep window contains the signal's timestamp; signals outside any
 * window are returned as `orphanSignals`.
 *
 * Task status derivation: per-task composites (`sequential('task-<id>', …)`) do NOT emit a
 * self-trace entry — only leaves do. Likewise no producer emits `chain-step-started` events
 * (the runner bridge only translates terminal trace entries). So status is derived from the
 * per-task substep trace alone:
 *
 *  - any substep failed/aborted (terminally) → that status (last-wins for failed-vs-aborted)
 *  - last expected substep (`uninstall-skills-<id>`) recorded → `completed`
 *  - any substep recorded, but not yet `uninstall-skills` → `running`
 *  - no substeps recorded → `pending`
 *
 * The function is pure and total — empty inputs yield `{ tasks: [], orphanSignals: [] }`.
 * The execute view re-runs it on every render; that's fine because the cost is linear and the
 * inputs are bounded (trace ≤ flow length, chainEvents capped by the hook buffer).
 */

import type { Trace, TraceStatus } from '@src/application/chain/trace.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';

/**
 * UUIDv7 suffix on a per-task leaf name (`<leaf>-<36-char-uuid>`). Exported so the execute
 * view's "outer flow" filter can identify per-task substeps without redeclaring the pattern.
 */
export const UUID_SUFFIX_REGEX = /-([0-9a-fA-F-]{36})$/;
export const TOP_LEVEL_TASK_REGEX = /^task-[0-9a-fA-F-]{36}$/;

/** True when an element name belongs to a per-task subchain (top-level or any nested leaf). */
export const isPerTaskLeaf = (name: string): boolean => TOP_LEVEL_TASK_REGEX.test(name) || UUID_SUFFIX_REGEX.test(name);

/**
 * Default per-task subchain terminal substep — when this leaf appears for a task id, the task's
 * overall status flips to `completed`. Matches the implement flow. Flows with a different
 * terminal leaf override via {@link BucketOptions.terminalSubstepName}.
 */
const DEFAULT_TERMINAL_SUBSTEP = 'uninstall-skills';

export type TaskBucketStatus = TraceStatus | 'running' | 'pending';

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
   */
  readonly genEvalRound: number;
  /** Configured cap for the gen-eval-loop, when known. Surfaced as `round N/M` in the panel. */
  readonly genEvalMaxRounds?: number;
}

export interface BucketedExecution {
  readonly tasks: readonly TaskBucket[];
  readonly orphanSignals: readonly HarnessSignal[];
}

interface TaskWindow {
  readonly startedAt: string;
  endedAt?: string;
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
 * Build per-task time windows from chain-step-completed events. The chain bridge emits one
 * `chain-step-completed` per leaf with the leaf's element name + ISO timestamp; we treat the
 * earliest substep timestamp for a task as the window start and the latest as the window end.
 * This is approximate — a signal emitted between two substeps may attribute to either — but
 * good enough for the UI bucketing where the alternative is "no window, everything orphans."
 */
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

/**
 * Per-task time-window for the signal-attribution binary-search. Compared to {@link TaskWindow}
 * this carries the taskId inline (so we don't need a parallel Map lookup) and is captured in
 * an array sorted by `startedAt`. Tasks run sequentially in the implement chain so windows
 * don't overlap — that's what lets the search find at most one candidate per signal.
 */
interface WindowEntry {
  readonly taskId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

/**
 * Binary-search the latest window with `startedAt <= ts`. Returns the index, or -1 when ts
 * predates every window. Sorted-input precondition; matches the standard "lower_bound from
 * the right" pattern.
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
 * O(signals + windows log windows) bucketing — replaced the original O(signals × windows) inner
 * loop because long-running sessions with high signal volume (1000+) made per-render bucketing
 * a hot spot in the TUI. Tasks run sequentially in the implement chain so windows never
 * overlap; that invariant lets us sort by startedAt once and binary-search per signal.
 */
const bucketSignals = (
  signals: readonly HarnessSignal[],
  windows: Map<string, TaskWindow>
): {
  signalsByTask: Map<string, HarnessSignal[]>;
  evaluationsByTask: Map<string, EvaluationSignal[]>;
  orphans: HarnessSignal[];
} => {
  const signalsByTask = new Map<string, HarnessSignal[]>();
  const evaluationsByTask = new Map<string, EvaluationSignal[]>();
  const orphans: HarnessSignal[] = [];

  const sortedWindows: WindowEntry[] = [];
  for (const [taskId, w] of windows) {
    sortedWindows.push(
      w.endedAt !== undefined
        ? { taskId, startedAt: w.startedAt, endedAt: w.endedAt }
        : { taskId, startedAt: w.startedAt }
    );
  }
  sortedWindows.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));

  for (const sig of signals) {
    const ts = String(sig.timestamp);
    const idx = findOwningWindow(sortedWindows, ts);
    const candidate = idx >= 0 ? sortedWindows[idx] : undefined;
    const owner =
      candidate !== undefined && (candidate.endedAt === undefined || ts <= candidate.endedAt)
        ? candidate.taskId
        : undefined;

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

/**
 * Derive the task-level status from its substep trace. See module docstring for the algorithm.
 * `failed` / `aborted` win over later `completed` substeps (the task subchain short-circuits
 * on the first failure via `sequential`'s contract).
 */
const resolveStatusFromSubSteps = (subSteps: readonly TaskSubStep[], terminalSubstepName: string): TaskBucketStatus => {
  if (subSteps.length === 0) return 'pending';
  for (const sub of subSteps) {
    if (sub.status === 'aborted') return 'aborted';
    if (sub.status === 'failed') return 'failed';
  }
  const lastSeen = subSteps.some((s) => s.leafName === terminalSubstepName);
  return lastSeen ? 'completed' : 'running';
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

/**
 * Two `commit-message` signals reach the bus per task: the AI's parse-time signal (subject +
 * optional body, no `fullMessage`) and the harness's re-emission AFTER `assembleCommitMessage`
 * + the `Closes …` trailer (carries `fullMessage`). The UI only wants the latter — showing
 * both produces a stuttered "feat(auth): …" row followed by the resolved version a few seconds
 * later. Drop the parse-time signal whenever a harness-resolved version exists in the same
 * bucket. When the harness signal hasn't landed yet (mid-task), the AI's preview is the only
 * source of truth and is shown.
 *
 * Pure function over a signal list — no side effects, no ordering changes for non-commit
 * signals. Returns the input unchanged when ≤1 commit-message signal is present.
 */
const dedupCommitMessages = (signals: readonly HarnessSignal[]): readonly HarnessSignal[] => {
  const hasResolved = signals.some((s) => s.type === 'commit-message' && s.fullMessage !== undefined);
  if (!hasResolved) return signals;
  return signals.filter((s) => s.type !== 'commit-message' || s.fullMessage !== undefined);
};

export interface BucketOptions {
  /** Configured cap on gen-eval-loop iterations (`config.harness.maxTurns`). */
  readonly maxTurns?: number;
  /**
   * Name of the per-task subchain's final leaf — when it appears in the trace the task flips to
   * `completed`. Defaults to `'uninstall-skills'` (the implement flow's terminal leaf). Decoupling
   * this from a hard-coded constant means a flow that renames its terminal leaf can override
   * via the launcher without breaking the UI.
   */
  readonly terminalSubstepName?: string;
  /**
   * Tasks the launcher knows about up front (e.g. from `tasks.json`) — used to synthesise
   * `pending` buckets for ids that have NO trace entries yet. Without this hint, a chain that
   * fails before any per-task leaf runs (e.g. `setup-script-runner` aborts the chain) leaves
   * `bucketed.tasks` empty and the Tasks panel renders its "panel empty · Run plan" empty
   * state — which is misleading when tasks DO exist in the sprint, they just haven't started.
   * Listed ids appear in input order at the END of the bucket list so already-traced tasks
   * keep their event-order position.
   */
  readonly knownTaskIds?: readonly string[];
}

export const bucketTaskSignals = (
  trace: Trace,
  chainEvents: readonly AppEvent[],
  signals: readonly HarnessSignal[],
  opts: BucketOptions = {}
): BucketedExecution => {
  const terminalSubstepName = opts.terminalSubstepName ?? DEFAULT_TERMINAL_SUBSTEP;
  const { order, byId: windows } = buildTaskWindows(chainEvents);
  const subStepsByTask = collectSubSteps(trace);
  const { signalsByTask, evaluationsByTask, orphans } = bucketSignals(signals, windows);

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  for (const id of subStepsByTask.keys()) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  // Append any known task ids that haven't traced yet so the panel shows pending rows instead
  // of collapsing to the "panel empty" state when a chain fails before per-task work starts.
  // These get an empty substep list → `resolveStatusFromSubSteps` returns 'pending'.
  if (opts.knownTaskIds !== undefined) {
    for (const id of opts.knownTaskIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

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
      signals: dedupCommitMessages(signalsByTask.get(id) ?? []),
      genEvalRound,
      ...(opts.maxTurns !== undefined ? { genEvalMaxRounds: opts.maxTurns } : {}),
    };
  });

  return { tasks, orphanSignals: dedupCommitMessages(orphans) };
};
