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
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { StepStart, Trace } from '@src/application/chain/trace.ts';
import { buildPlanTree, type PlanNode } from '@src/application/chain/plan-tree.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { InProcessRuns } from '@src/application/session/in-process-runs.ts';
import type { SessionHints } from '@src/application/ui/shared/launcher.ts';

/** Terminal records older than this are TTL-evicted, bounding the descriptor map in long TUI sessions. */
const SESSION_RECORD_TTL_MS = 30 * 60 * 1000;
/** Soft cap on the descriptor map: only terminal records are dropped to honour it, so a live view is never lost. */
const SESSION_LRU_CAP = 50;
/**
 * Hard ceiling — emergency relief. Past it the OLDEST running records are dropped too, so a burst
 * of never-terminating runs cannot grow the map unboundedly. Healthy sessions never get near it.
 */
const SESSION_RUNNING_CEILING = 200;

const isTerminal = (status: RunnerStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

// Falls back to `startedAt` so a terminal record that never got `finishedAt` is still LRU-evictable.
const ageKey = (rec: SessionRecord): number => rec.descriptor.finishedAt ?? rec.descriptor.startedAt;

/**
 * Frozen replacement for a terminal record's runner: keeps identity, status and trace but drops the
 * live runner closure, whose captured `ctx` (worktree paths, task list, accumulators) would
 * otherwise be pinned until eviction. `subscribe` replays the captured trace + terminal event, so
 * consumers cannot tell the difference.
 */
const terminalRunnerStub = (
  id: string,
  element: Runner<unknown>['element'],
  status: RunnerStatus,
  trace: Trace,
  error: DomainError | undefined
): Runner<unknown> => ({
  id,
  element,
  status,
  ctx: undefined,
  trace,
  start: () => Promise.resolve(),
  abort: () => {},
  subscribe: (listener) => {
    for (const entry of trace) listener({ type: 'step', entry });
    if (status === 'completed') listener({ type: 'completed', ctx: undefined });
    else if (status === 'failed' && error !== undefined) listener({ type: 'failed', error });
    else if (status === 'aborted' || status === 'failed') listener({ type: 'aborted' });
    return () => {};
  },
});

/**
 * Leaves currently running, keyed by element name (several at once under parallel waves). Mutated
 * in place; `version` bumps on every change so memoised projections can invalidate. Late
 * subscribers get no replay of started events — only the live state matters.
 */
export interface SessionLive {
  readonly inFlight: Map<string, StepStart>;
  version: number;
}

export interface SessionDescriptor extends SessionHints {
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
  /** The runner's element tree, derived once at registration; the flow-steps display projects it against the trace and `live`. */
  readonly planTree?: PlanNode;
  /** Shared-mutable in-flight state (same pattern as `trace`): mutated in place, never rebuilt. */
  readonly live?: SessionLive;
}

export interface SessionRecord {
  readonly descriptor: SessionDescriptor;
  /** The underlying runner — hold a reference so `abort()` works from the UI. */
  readonly runner: Runner<unknown>;
}

export type SessionListener = () => void;

// TTL pass: drop terminal records older than the window.
const evictExpiredTerminals = (records: Map<string, SessionRecord>, now: number): boolean => {
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
  records: Map<string, SessionRecord>,
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

const evict = (records: Map<string, SessionRecord>, now: number): boolean => {
  let removed = evictExpiredTerminals(records, now);
  // Soft LRU: shed the oldest TERMINAL records (running / queued are protected).
  removed =
    evictOldestWhileOverCap(records, SESSION_LRU_CAP, (r) => isTerminal(r.descriptor.status), ageKey) || removed;
  // Emergency relief: if STILL over the hard ceiling, terminal records are exhausted and the
  // overflow is live runs (the leak pathology). Shed the oldest RUNNING records as last resort —
  // a healthy session never reaches the ceiling; their runners keep running detached.
  removed =
    evictOldestWhileOverCap(
      records,
      SESSION_RUNNING_CEILING,
      (r) => !isTerminal(r.descriptor.status),
      (r) => r.descriptor.startedAt
    ) || removed;
  return removed;
};

interface Store {
  readonly records: Map<string, SessionRecord>;
  readonly clock: () => number;
  notify(): void;
  update(id: string, patch: Partial<SessionDescriptor>): void;
  subscribe(fn: SessionListener): () => void;
}

const createStore = (clock: () => number): Store => {
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

  const update = (id: string, patch: Partial<SessionDescriptor>): void => {
    const cur = records.get(id);
    if (!cur) return;
    const descriptor = { ...cur.descriptor, ...patch };
    const goingTerminal = patch.status !== undefined && isTerminal(patch.status);
    const curLive = cur.descriptor.live;
    if (goingTerminal && curLive !== undefined && curLive.inFlight.size > 0) {
      curLive.inFlight.clear();
      curLive.version += 1;
    }
    const runner = goingTerminal
      ? terminalRunnerStub(cur.runner.id, cur.runner.element, patch.status!, descriptor.trace, descriptor.error)
      : cur.runner;
    records.set(id, { descriptor, runner });
    if (goingTerminal) evict(records, clock());
    notify();
  };

  return {
    records,
    clock,
    notify,
    update,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
};

/**
 * Drive the descriptor from the runner's events, detaching once it reaches terminal so a dead run
 * does not keep its trace buffer alive through `runner.subscribe`'s listener set. `step` events
 * only bump `live`: the descriptor's `trace` is the runner's shared-mutable array, so rebuilding
 * the descriptor per step would invalidate `useBucketedTasks` on every leaf of every task.
 */
const trackRunner = ({ records, clock, notify, update }: Store, runner: Runner<unknown>, live: SessionLive): void => {
  const id = runner.id;
  const touch = (): void => {
    live.version += 1;
    if (records.has(id)) notify();
  };
  const settle = (patch: Partial<SessionDescriptor>): void => {
    update(id, { finishedAt: clock(), trace: runner.trace, ...patch });
    detach();
  };
  // A terminal runner replays synchronously, before `subscribe` has returned the real unsubscribe.
  let detachLater = false;
  let detach = (): void => {
    detachLater = true;
  };
  detach = runner.subscribe((event) => {
    switch (event.type) {
      case 'started':
        update(id, { status: 'running' });
        return;
      case 'step-started':
        live.inFlight.set(event.step.elementName, event.step);
        touch();
        return;
      case 'step':
        live.inFlight.delete(event.entry.elementName);
        touch();
        return;
      case 'completed':
        settle({ status: 'completed' });
        return;
      case 'failed':
        settle({ status: 'failed', error: event.error });
        return;
      case 'aborted':
        settle({ status: 'aborted' });
    }
  });
  if (detachLater) detach();
};

export interface SessionManager {
  list(): readonly SessionRecord[];
  get(id: string): SessionRecord | undefined;
  /**
   * Register a runner with the manager. The manager subscribes immediately, drives the
   * descriptor through its lifecycle (running → completed/failed/aborted), and notifies the
   * registered listeners on every transition.
   */
  register(
    input: {
      readonly runner: Runner<unknown>;
      readonly flowId: string;
      readonly title: string;
    } & SessionHints
  ): SessionRecord;
  /** Request the runner to abort. No-op if the session is already terminal. */
  abort(id: string): void;
  /** Drop a session from the registry. Used after the user dismisses a finished run. */
  remove(id: string): void;
  /**
   * Emergency memory relief: drop EVERY terminal record immediately, ignoring TTL / LRU. Returns
   * the number dropped. Running / queued records are untouched.
   */
  shedTerminal(): number;
  /**
   * Retroactively pin the sprint on an existing descriptor, for launchers that create the sprint
   * mid-run (create-sprint). No-op if the runner id is not found.
   */
  setPinnedSprint(runnerId: string, sprintId: SprintId, sprintLabel: string): void;
  /** Subscribe to "registry changed" notifications. */
  subscribe(fn: SessionListener): () => void;
}

export const createSessionManager = (opts?: {
  readonly clock?: () => number;
  /** Told about every registered runner, so data-removal guards count it as active until it settles. */
  readonly runs?: Pick<InProcessRuns, 'track'>;
}): SessionManager => {
  const clock = opts?.clock ?? Date.now;
  const store = createStore(clock);
  const { records, notify } = store;

  return {
    list: () => [...records.values()].sort((a, b) => a.descriptor.startedAt - b.descriptor.startedAt),
    get: (id) => records.get(id),
    register: (input) => {
      opts?.runs?.track(input.runner, {
        flowId: input.flowId,
        ...(input.pinnedProjectId !== undefined ? { projectId: String(input.pinnedProjectId) } : {}),
        ...(input.pinnedSprintId !== undefined ? { sprintId: String(input.pinnedSprintId) } : {}),
      });
      // `runner` is destructured out so the live runner's heavy ctx is never pinned on the descriptor.
      const { runner, flowId, title, ...hints } = input;
      evict(records, clock());
      const live: SessionLive = { inFlight: new Map(), version: 0 };
      // Test doubles may omit `element`; a real runner always has one.
      const element: Runner<unknown>['element'] | undefined = runner.element;
      const record: SessionRecord = {
        descriptor: {
          id: runner.id,
          flowId,
          title,
          status: runner.status,
          startedAt: clock(),
          trace: runner.trace,
          ...hints,
          ...(element !== undefined ? { planTree: buildPlanTree(element) } : {}),
          live,
        },
        runner,
      };
      records.set(runner.id, record);
      notify();
      trackRunner(store, runner, live);
      return record;
    },
    abort: (id) => records.get(id)?.runner.abort('user requested'),
    remove: (id) => {
      if (records.delete(id)) notify();
    },
    shedTerminal: () => {
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
    setPinnedSprint: (runnerId, sprintId, sprintLabel) =>
      store.update(runnerId, { pinnedSprintId: sprintId, pinnedSprintLabel: sprintLabel }),
    subscribe: store.subscribe,
  };
};
