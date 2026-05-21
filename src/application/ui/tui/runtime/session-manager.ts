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
import type { Trace } from '@src/application/chain/trace.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';

/**
 * Terminal SessionRecords older than this are eligible for TTL eviction. Bounds the descriptor
 * map for long-running TUI sessions that fire many runs back-to-back.
 */
const SESSION_RECORD_TTL_MS = 30 * 60 * 1000;
/**
 * Hard cap on the descriptor map. Only terminal records are dropped to honour the cap; running
 * and queued records are kept regardless of pressure so the operator never loses the live view.
 */
const SESSION_LRU_CAP = 50;

const isTerminal = (status: RunnerStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

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
  /**
   * Element-tree leaf names in DFS order, captured at chain construction time. The Flow-steps
   * panel renders these as pending rows so the operator sees the *whole* plan upfront and
   * which steps are still ahead — not just the trace of what already ran.
   */
  readonly plannedLeaves?: readonly string[];
  /**
   * Name of the per-task subchain's final leaf (`'uninstall-skills'` for the implement flow). When
   * the bucketing sees this leaf for a task id it flips the task to `completed`. Threaded from
   * the launcher so flows with a different terminal leaf — or future renames — don't break the
   * UI silently.
   */
  readonly terminalSubstepName?: string;
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
    readonly plannedLeaves?: readonly string[];
    readonly terminalSubstepName?: string;
  }): SessionRecord;
  /** Request the runner to abort. No-op if the session is already terminal. */
  abort(id: string): void;
  /** Drop a session from the registry. Used after the user dismisses a finished run. */
  remove(id: string): void;
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

  const evict = (now: number): boolean => {
    let removed = false;
    // TTL pass: drop terminal records older than the window.
    for (const [id, rec] of records) {
      const { status } = rec.descriptor;
      if (isTerminal(status) && now - ageKey(rec) > SESSION_RECORD_TTL_MS) {
        records.delete(id);
        removed = true;
      }
    }
    // LRU pass: while above cap, drop the oldest terminal record (by ageKey asc). Running /
    // queued records are never evicted — the cap is best-effort under that constraint.
    if (records.size > SESSION_LRU_CAP) {
      const terminals = [...records.values()]
        .filter((rec) => isTerminal(rec.descriptor.status))
        .sort((a, b) => ageKey(a) - ageKey(b));
      for (const rec of terminals) {
        if (records.size <= SESSION_LRU_CAP) break;
        records.delete(rec.descriptor.id);
        removed = true;
      }
    }
    return removed;
  };

  const update = (id: string, patch: Partial<SessionDescriptor>): void => {
    const cur = records.get(id);
    if (!cur) return;
    records.set(id, { ...cur, descriptor: { ...cur.descriptor, ...patch } });
    if (patch.status !== undefined && isTerminal(patch.status)) {
      evict(clock());
    }
    notify();
  };

  return {
    list(): readonly SessionRecord[] {
      return [...records.values()].sort((a, b) => a.descriptor.startedAt - b.descriptor.startedAt);
    },
    get(id: string): SessionRecord | undefined {
      return records.get(id);
    },
    register({ runner, flowId, title, taskNames, maxTurns, plannedLeaves, terminalSubstepName }): SessionRecord {
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
        ...(plannedLeaves !== undefined ? { plannedLeaves } : {}),
        ...(terminalSubstepName !== undefined ? { terminalSubstepName } : {}),
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
            update(runner.id, { trace: runner.trace });
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
    subscribe(fn: SessionListener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
};
