/**
 * Session manager — tracks live `Runner`s and broadcasts their lifecycle to the TUI. The
 * execute view is one of several panels that subscribe; sessions are referenced by the chain
 * runner's id everywhere else (events, view props, history).
 *
 * Late-attachment is built in: the runner already replays its trace on `subscribe`, and this
 * manager keeps the descriptor around past terminal so navigating into a finished session shows
 * its outcome instead of a stale "running" frame.
 */

import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';

/**
 * Terminal SessionRecords older than this are eligible for TTL eviction. Bounds the descriptor
 * map for long-running TUI sessions that fire many runs back-to-back.
 */
const SESSION_RECORD_TTL_MS = 30 * 60 * 1000;
/**
 * Soft cap on the descriptor map. Only terminal records are dropped to honour it; running and
 * queued records are kept regardless of pressure so the operator never loses the live view. The
 * hard {@link SESSION_RUNNING_CEILING} is the emergency relief that CAN drop running records.
 */
const SESSION_LRU_CAP = 50;

/**
 * Hard ceiling — the emergency-relief tier. The soft {@link SESSION_LRU_CAP} only sheds terminal
 * records, so a pathological burst of never-terminating runs (the long-session leak signature)
 * could grow the map unboundedly while every record reports `running`. Once the map exceeds THIS
 * ceiling we drop the OLDEST running records too, oldest-first, as last-resort memory relief.
 * Sized comfortably above the soft cap so it only ever fires under genuine pathology — a healthy
 * session never has 200 concurrent live runs.
 */
const SESSION_RUNNING_CEILING = 200;

const isTerminal = (status: RunnerStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

/**
 * Replace a terminal record's live {@link Runner} with a frozen stub that preserves the identity +
 * status + trace the UI reads, but drops the strong reference to the live runner closure — whose
 * captured `ctx` is the heavy forked `ImplementCtx` (worktree paths, task list, accumulators) that
 * would otherwise be pinned until the record's TTL / LRU eviction. The descriptor already snapshots
 * the trace, and no UI path reads `record.runner.ctx` after terminal; `abort()` is a no-op once
 * terminal and `subscribe()` replays the (already-captured) trace + terminal event, so the stub is
 * behaviourally indistinguishable to every consumer while freeing the dominant retainer at terminal.
 */
const terminalRunnerStub = (
  id: string,
  status: RunnerStatus,
  trace: Trace,
  error: DomainError | undefined
): Runner<unknown> => ({
  id,
  status,
  ctx: undefined,
  trace,
  start: () => Promise.resolve(),
  abort: () => {},
  subscribe: (listener) => {
    // Late-attach replay: hand the captured trace + matching terminal event to the new listener,
    // mirroring the live runner's late-subscriber contract. Nothing further is ever emitted.
    for (const entry of trace) listener({ type: 'step', entry });
    if (status === 'completed') listener({ type: 'completed', ctx: undefined });
    else if (status === 'failed' && error !== undefined) listener({ type: 'failed', error });
    else if (status === 'aborted' || status === 'failed') listener({ type: 'aborted' });
    return () => {};
  },
});

export interface SessionDescriptor {
  readonly id: string;
  /** Stable flow identifier — drives the title shown in panels. */
  readonly flowId: string;
  /** Human-friendly title (`Implement — sprint X`). */
  readonly title: string;
  readonly status: RunnerStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly trace: Trace;
  readonly error?: DomainError;
  /**
   * Map of `taskId → displayName` for runs that operate on a known task set (e.g. Implement).
   * The execute view substitutes these into the Tasks panel so per-task blocks render with the
   * sprint's task name (`Implement multi-select`) instead of the raw uuid prefix (`019e2d4b…`).
   */
  readonly taskNames?: ReadonlyMap<string, string>;
  /** Configured max iterations for any gen-eval loop inside the run (used as the `round N/M` cap). */
  readonly maxTurns?: number;
  /** Configured cap on attempts per task (used as the `attempt A/X` cap). */
  readonly maxAttempts?: number;
  /**
   * Element-tree leaf names in DFS order, captured at chain construction time. The Flow-steps
   * panel renders these as pending rows so the operator sees the *whole* plan upfront and
   * which steps are still ahead — not just the trace of what already ran.
   */
  readonly plannedLeaves?: readonly string[];
  /**
   * Display label per planned leaf name, captured at chain construction time so the rail can
   * render pending / running rows with their friendly label instead of falling back to the
   * raw element name (which embeds the absolute path for per-repo leaves like
   * `preflight-task-1-/abs/path/to/repo`). Once a leaf executes, the trace entry's own label
   * supersedes this lookup.
   */
  readonly planLabelByName?: ReadonlyMap<string, string>;
  /**
   * Name of the per-task subchain's final leaf (`'uninstall-skills'` for the implement flow). When
   * the bucketing sees this leaf for a task id it flips the task to `completed`. Threaded from
   * the launcher so flows with a different terminal leaf — or future renames — don't break the
   * UI silently.
   */
  readonly terminalSubstepName?: string;
  /**
   * Map of `taskId → RecoveryContext` for tasks the launcher detected as resuming a prior
   * aborted attempt. The launcher derives this at click time from any `in_progress` tasks
   * whose last attempt is still `running` (a v8 OOM / Ctrl-C / SIGTERM in the prior process
   * leaves that signature). The execute view surfaces it as an annotation under the active
   * task header. Empty / undefined when no task is resuming.
   */
  readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
  /**
   * Implement-flow gen-eval models, captured from the launcher at click time. The execute
   * view renders `<gen-model> → <eval-model> (eval)` on the active-attempt rail when the two
   * models differ, and collapses to a single name when they match. Only set for the implement
   * flow; every other flow leaves these undefined.
   */
  readonly generatorModel?: string;
  readonly evaluatorModel?: string;
  /**
   * Resolved effort strings for each implement role (`low|medium|high|xhigh|max`). Displayed
   * alongside the model name in the HeaderCard so the operator can see the effort at a glance.
   * Only set for the implement flow; every other flow leaves these undefined.
   */
  readonly generatorEffort?: string;
  readonly evaluatorEffort?: string;
  /**
   * Project and sprint the run was launched against, pinned at launch time for the run's
   * lifetime. The execute view reads these to identify the run's own sprint independently of
   * the mutable global selection. Undefined when the flow was not launched against a project
   * or sprint (e.g. create-sprint leaves pinnedSprintId unset because the sprint does not
   * yet exist at launch time).
   */
  readonly pinnedProjectId?: ProjectId;
  readonly pinnedProjectLabel?: string;
  readonly pinnedSprintId?: SprintId;
  readonly pinnedSprintLabel?: string;
}

export interface SessionRecord {
  readonly descriptor: SessionDescriptor;
  /** The underlying runner — hold a reference so `abort()` works from the UI. */
  readonly runner: Runner<unknown>;
}

export type SessionListener = () => void;

export interface SessionManager {
  list(): readonly SessionRecord[];
  get(id: string): SessionRecord | undefined;
  /**
   * Register a runner with the manager. The manager subscribes immediately, drives the
   * descriptor through its lifecycle (running → completed/failed/aborted), and notifies the
   * registered listeners on every transition.
   */
  register(input: {
    readonly runner: Runner<unknown>;
    readonly flowId: string;
    readonly title: string;
    readonly taskNames?: ReadonlyMap<string, string>;
    readonly maxTurns?: number;
    readonly maxAttempts?: number;
    readonly plannedLeaves?: readonly string[];
    readonly planLabelByName?: ReadonlyMap<string, string>;
    readonly terminalSubstepName?: string;
    readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
    readonly generatorModel?: string;
    readonly evaluatorModel?: string;
    readonly generatorEffort?: string;
    readonly evaluatorEffort?: string;
    readonly pinnedProjectId?: ProjectId;
    readonly pinnedProjectLabel?: string;
    readonly pinnedSprintId?: SprintId;
    readonly pinnedSprintLabel?: string;
  }): SessionRecord;
  /** Request the runner to abort. No-op if the session is already terminal. */
  abort(id: string): void;
  /** Drop a session from the registry. Used after the user dismisses a finished run. */
  remove(id: string): void;
  /**
   * Emergency memory relief: drop EVERY terminal record immediately, ignoring TTL / LRU. Returns
   * the number dropped. Invoked by the heap-critical handler when the heap crosses the critical
   * band — terminal records (with their trace snapshots) are the largest sheddable retainer the
   * app root can reach without disturbing any live run. Running / queued records are untouched, so
   * a healthy in-flight run is never aborted.
   */
  shedTerminal(): number;
  /**
   * Retroactively pin the sprint on an existing descriptor. Called by sprint-bound launchers
   * when the sprint is created mid-run (e.g. create-sprint) so the descriptor's pinned sprint
   * fields are updated once the id/name become known. No-op if the runner id is not found.
   */
  setPinnedSprint(runnerId: string, sprintId: SprintId, sprintLabel: string): void;
  /** Subscribe to "registry changed" notifications. */
  subscribe(fn: SessionListener): () => void;
}

export const createSessionManager = (opts?: { readonly clock?: () => number }): SessionManager => {
  const clock = opts?.clock ?? Date.now;
  const records = new Map<string, SessionRecord>();
  const listeners = new Set<SessionListener>();

  const notify = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.warn('[session-manager] listener threw:', err);
      }
    }
  };

  // Age key for ordering / TTL: prefer the descriptor's `finishedAt`. Terminal records
  // registered via the synthetic-replay path (runner reaches terminal before `register()` runs)
  // will have `finishedAt` populated during the sync replay — but if a future runner contract
  // change drops that guarantee, fall back to `startedAt` so the record is still LRU-eligible
  // instead of becoming an un-evictable leak.
  const ageKey = (rec: SessionRecord): number => rec.descriptor.finishedAt ?? rec.descriptor.startedAt;

  // TTL pass: drop terminal records older than the window.
  const evictExpiredTerminals = (now: number): boolean => {
    let removed = false;
    for (const [id, rec] of records) {
      if (isTerminal(rec.descriptor.status) && now - ageKey(rec) > SESSION_RECORD_TTL_MS) {
        records.delete(id);
        removed = true;
      }
    }
    return removed;
  };

  // While above `cap`, drop the oldest record matching `pick`, ordered ascending by `order`.
  const evictOldestWhileOverCap = (
    cap: number,
    pick: (rec: SessionRecord) => boolean,
    order: (rec: SessionRecord) => number
  ): boolean => {
    if (records.size <= cap) return false;
    let removed = false;
    const candidates = [...records.values()].filter(pick).sort((a, b) => order(a) - order(b));
    for (const rec of candidates) {
      if (records.size <= cap) break;
      records.delete(rec.descriptor.id);
      removed = true;
    }
    return removed;
  };

  const evict = (now: number): boolean => {
    let removed = evictExpiredTerminals(now);
    // Soft LRU: shed the oldest TERMINAL records (running / queued are protected).
    removed = evictOldestWhileOverCap(SESSION_LRU_CAP, (r) => isTerminal(r.descriptor.status), ageKey) || removed;
    // Emergency relief: if STILL over the hard ceiling, terminal records are exhausted and the
    // overflow is live runs (the leak pathology). Shed the oldest RUNNING records as last resort —
    // a healthy session never reaches the ceiling; their runners keep running detached.
    removed =
      evictOldestWhileOverCap(
        SESSION_RUNNING_CEILING,
        (r) => !isTerminal(r.descriptor.status),
        (r) => r.descriptor.startedAt
      ) || removed;
    return removed;
  };

  const update = (id: string, patch: Partial<SessionDescriptor>): void => {
    const cur = records.get(id);
    if (!cur) return;
    const descriptor = { ...cur.descriptor, ...patch };
    const goingTerminal = patch.status !== undefined && isTerminal(patch.status);
    // On the terminal transition, swap the live runner for a frozen stub that keeps id/status/trace
    // but drops the strong reference to the heavy forked ctx (the implement worktree ctx). The
    // descriptor already snapshots the trace; nothing reads `runner.ctx` after terminal. This frees
    // the dominant retainer AT terminal instead of waiting for TTL / LRU eviction. The original
    // runner is no longer needed — its `abort()` is a no-op once terminal.
    const runner = goingTerminal
      ? terminalRunnerStub(cur.runner.id, patch.status!, descriptor.trace, descriptor.error)
      : cur.runner;
    records.set(id, { descriptor, runner });
    if (goingTerminal) evict(clock());
    notify();
  };

  /**
   * Trace-only "step" wakeup. The descriptor's `trace` field already points at the runner's
   * shared-mutable trace array from `register()` (the runner never reassigns it — see runner.ts),
   * so a `step` mutates that array IN PLACE and the descriptor needs NO rebuild. We therefore notify
   * subscribers WITHOUT spreading a fresh descriptor / record. This kills the per-step amplifier:
   * previously every `step` allocated a new descriptor object, which invalidated the execute view's
   * `useBucketedTasks` memo (keyed on the descriptor reference) and re-ran `bucketTaskSignals` over
   * the whole trace on every leaf step of every task. Status-gated consumers (`useSessions` /
   * `useSession` / `use-sprint-bundle`) already ignore step notifies; the live flow-steps rail stays
   * current via the shared-mutable trace array + the sibling chainEvents re-render, exactly as the
   * sigOf comment in sessions-context.tsx documents.
   */
  const touchTrace = (id: string): void => {
    if (!records.has(id)) return;
    notify();
  };

  return {
    list(): readonly SessionRecord[] {
      return [...records.values()].sort((a, b) => a.descriptor.startedAt - b.descriptor.startedAt);
    },
    get(id: string): SessionRecord | undefined {
      return records.get(id);
    },
    register({
      runner,
      flowId,
      title,
      taskNames,
      maxTurns,
      maxAttempts,
      plannedLeaves,
      planLabelByName,
      terminalSubstepName,
      taskRecovering,
      generatorModel,
      evaluatorModel,
      generatorEffort,
      evaluatorEffort,
      pinnedProjectId,
      pinnedProjectLabel,
      pinnedSprintId,
      pinnedSprintLabel,
    }): SessionRecord {
      evict(clock());
      const descriptor: SessionDescriptor = {
        id: runner.id,
        flowId,
        title,
        status: runner.status,
        startedAt: clock(),
        trace: runner.trace,
        ...(taskNames !== undefined ? { taskNames } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(plannedLeaves !== undefined ? { plannedLeaves } : {}),
        ...(planLabelByName !== undefined ? { planLabelByName } : {}),
        ...(terminalSubstepName !== undefined ? { terminalSubstepName } : {}),
        ...(taskRecovering !== undefined ? { taskRecovering } : {}),
        ...(generatorModel !== undefined ? { generatorModel } : {}),
        ...(evaluatorModel !== undefined ? { evaluatorModel } : {}),
        ...(generatorEffort !== undefined ? { generatorEffort } : {}),
        ...(evaluatorEffort !== undefined ? { evaluatorEffort } : {}),
        ...(pinnedProjectId !== undefined ? { pinnedProjectId } : {}),
        ...(pinnedProjectLabel !== undefined ? { pinnedProjectLabel } : {}),
        ...(pinnedSprintId !== undefined ? { pinnedSprintId } : {}),
        ...(pinnedSprintLabel !== undefined ? { pinnedSprintLabel } : {}),
      };
      const record: SessionRecord = { descriptor, runner: runner as Runner<unknown> };
      records.set(runner.id, record);
      notify();

      // Mirror the chain-runner-bridge pattern: hold the unsubscribe in a 1-slot box so the
      // listener can release itself on terminal. Without this, every dead Implement run leaves
      // a permanent listener on `runner.subscribe`'s internal Set across a long multi-run TUI
      // session — and each closure pins the runner's trace buffer for the harness lifetime.
      let unsub: (() => void) | null = null;
      let pendingDetach = false;
      const detach = (): void => {
        if (unsub === null) {
          pendingDetach = true;
          return;
        }
        const fn = unsub;
        unsub = null;
        fn();
      };

      unsub = runner.subscribe((event) => {
        switch (event.type) {
          case 'started':
            update(runner.id, { status: 'running' });
            return;
          case 'step':
            touchTrace(runner.id); // trace-only wakeup, no descriptor rebuild — see touchTrace
            return;
          case 'completed':
            update(runner.id, { status: 'completed', finishedAt: clock(), trace: runner.trace });
            detach();
            return;
          case 'failed':
            update(runner.id, {
              status: 'failed',
              finishedAt: clock(),
              trace: runner.trace,
              error: event.error,
            });
            detach();
            return;
          case 'aborted':
            update(runner.id, { status: 'aborted', finishedAt: clock(), trace: runner.trace });
            detach();
        }
      });
      // Sync-replay case (already-terminal runner during register): the listener fired before
      // `unsub` was assigned, so detach() recorded `pendingDetach` and returned. Re-run it now
      // that the assignment has completed.
      if (pendingDetach) detach();

      return record;
    },
    abort(id: string): void {
      const rec = records.get(id);
      rec?.runner.abort('user requested');
    },
    remove(id: string): void {
      if (records.delete(id)) notify();
    },
    shedTerminal(): number {
      let dropped = 0;
      for (const [id, rec] of records) {
        if (isTerminal(rec.descriptor.status)) {
          records.delete(id);
          dropped += 1;
        }
      }
      if (dropped > 0) notify();
      return dropped;
    },
    setPinnedSprint(runnerId: string, sprintId: SprintId, sprintLabel: string): void {
      update(runnerId, { pinnedSprintId: sprintId, pinnedSprintLabel: sprintLabel });
    },
    subscribe(fn: SessionListener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
};
