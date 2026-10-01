/** Session manager — tracks live `Runner`s and broadcasts their lifecycle to the TUI. */

import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Trace } from '@src/application/chain/trace.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { InProcessRuns } from '@src/application/session/in-process-runs.ts';

/**
 * Terminal SessionRecords older than this are eligible for TTL eviction. Bounds the descriptor map for long-running
 * TUI sessions that fire many runs back-to-back.
 */
const SESSION_RECORD_TTL_MS = 30 * 60 * 1000;
/** Soft cap on the descriptor map. */
const SESSION_LRU_CAP = 50;

/** Hard ceiling — the emergency-relief tier. */
const SESSION_RUNNING_CEILING = 200;

const isTerminal = (status: RunnerStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'aborted';

// Age key for ordering / TTL: prefer the descriptor's `finishedAt`.
const ageKey = (rec: SessionRecord): number => rec.descriptor.finishedAt ?? rec.descriptor.startedAt;

/**
 * Replace a terminal record's live {@link Runner} with a frozen stub that preserves the identity + status + trace the
 * UI reads.
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
  /** Map of `taskId → displayName` for runs that operate on a known task set (e.g. Implement). */
  readonly taskNames?: ReadonlyMap<string, string>;
  /** Configured max iterations for any gen-eval loop inside the run (used as the `round N/M` cap). */
  readonly maxTurns?: number;
  /** Configured cap on attempts per task (used as the `attempt A/X` cap). */
  readonly maxAttempts?: number;
  /** Element-tree leaf names in DFS order, captured at chain construction time. */
  readonly plannedLeaves?: readonly string[];
  /**
   * Display label per planned leaf name.
   */
  readonly planLabelByName?: ReadonlyMap<string, string>;
  /** Name of the per-task subchain's final leaf (`'uninstall-skills'` for the implement flow). */
  readonly terminalSubstepName?: string;
  /**
   * Map of `taskId → RecoveryContext` for tasks the launcher detected as resuming a prior aborted attempt.
   */
  readonly taskRecovering?: ReadonlyMap<string, RecoveryContext>;
  /** Implement-flow gen-eval models, captured from the launcher at click time. */
  readonly generatorModel?: string;
  readonly evaluatorModel?: string;
  /** Provider id backing each implement role (`claude-code` / `github-copilot` / `openai-codex`). */
  readonly generatorProvider?: AiProvider;
  readonly evaluatorProvider?: AiProvider;
  /** Resolved effort strings for each implement role (`low|medium|high|xhigh|max`). */
  readonly generatorEffort?: string;
  readonly evaluatorEffort?: string;
  /** Project and sprint the run was launched against, pinned at launch time for the run's lifetime. */
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

/**
 * The subset of {@link SessionDescriptor}'s optional fields that `register()` accepts directly from the caller (as
 * opposed to `finishedAt` / `error`.
 */
type RegisterOptionalFields = Pick<
  SessionDescriptor,
  | 'taskNames'
  | 'maxTurns'
  | 'maxAttempts'
  | 'plannedLeaves'
  | 'planLabelByName'
  | 'terminalSubstepName'
  | 'taskRecovering'
  | 'generatorModel'
  | 'evaluatorModel'
  | 'generatorProvider'
  | 'evaluatorProvider'
  | 'generatorEffort'
  | 'evaluatorEffort'
  | 'pinnedProjectId'
  | 'pinnedProjectLabel'
  | 'pinnedSprintId'
  | 'pinnedSprintLabel'
>;

/**
 * Mirrors {@link RegisterOptionalFields} but with every key REQUIRED (its value may still be `undefined`) — the shape
 * of a destructured `{ taskNames, maxTurns.
 */
type RegisterOptionalFieldsInput = {
  readonly [K in keyof RegisterOptionalFields]-?: RegisterOptionalFields[K] | undefined;
};

/** Copy only the DEFINED keys from `fields` onto a fresh object. */
const withDefinedFields = (fields: RegisterOptionalFieldsInput): RegisterOptionalFields => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as RegisterOptionalFields;
};

/** Subscribe to `runner`'s lifecycle, auto-detaching once the run reaches terminal. */
const attachRunnerLifecycle = (
  runner: Runner<unknown>,
  handlers: {
    readonly onStarted: () => void;
    readonly onStep: () => void;
    readonly onCompleted: () => void;
    readonly onFailed: (error: DomainError) => void;
    readonly onAborted: () => void;
  }
): void => {
  // `unsub` doubles as state: `null` before subscribe completes or after detach; a function while the subscription is
  // live.
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
        handlers.onStarted();
        return;
      case 'step':
        handlers.onStep(); // trace-only wakeup, no descriptor rebuild — see touchTrace
        return;
      case 'completed':
        handlers.onCompleted();
        detach();
        return;
      case 'failed':
        handlers.onFailed(event.error);
        detach();
        return;
      case 'aborted':
        handlers.onAborted();
        detach();
    }
  });
  // Sync-replay case (already-terminal runner during register): the listener fired before `unsub` was assigned, so
  // detach() recorded `pendingDetach` and returned.
  if (pendingDetach) detach();
};

const notify = (listeners: ReadonlySet<SessionListener>): void => {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.warn('[session-manager] listener threw:', err);
    }
  }
};

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
  // Emergency relief: if STILL over the hard ceiling, terminal records are exhausted and the overflow is live runs
  // (the leak pathology).
  removed =
    evictOldestWhileOverCap(
      records,
      SESSION_RUNNING_CEILING,
      (r) => !isTerminal(r.descriptor.status),
      (r) => r.descriptor.startedAt
    ) || removed;
  return removed;
};

const update = (
  records: Map<string, SessionRecord>,
  listeners: ReadonlySet<SessionListener>,
  clock: () => number,
  id: string,
  patch: Partial<SessionDescriptor>
): void => {
  const cur = records.get(id);
  if (!cur) return;
  const descriptor = { ...cur.descriptor, ...patch };
  const goingTerminal = patch.status !== undefined && isTerminal(patch.status);
  // On the terminal transition, swap the live runner for a frozen stub that keeps id/status/trace but drops the
  // strong reference to the heavy forked ctx (the implement worktree ctx).
  const runner = goingTerminal
    ? terminalRunnerStub(cur.runner.id, patch.status!, descriptor.trace, descriptor.error)
    : cur.runner;
  records.set(id, { descriptor, runner });
  if (goingTerminal) evict(records, clock());
  notify(listeners);
};

/** Trace-only "step" wakeup. */
const touchTrace = (
  records: ReadonlyMap<string, SessionRecord>,
  listeners: ReadonlySet<SessionListener>,
  id: string
): void => {
  if (!records.has(id)) return;
  notify(listeners);
};

const shedTerminalRecords = (records: Map<string, SessionRecord>, listeners: ReadonlySet<SessionListener>): number => {
  let dropped = 0;
  for (const [id, rec] of records) {
    if (isTerminal(rec.descriptor.status)) {
      records.delete(id);
      dropped += 1;
    }
  }
  if (dropped > 0) notify(listeners);
  return dropped;
};

const registerSession = (
  records: Map<string, SessionRecord>,
  listeners: ReadonlySet<SessionListener>,
  clock: () => number,
  input: Parameters<SessionManager['register']>[0]
): SessionRecord => {
  const {
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
    generatorProvider,
    evaluatorProvider,
    generatorEffort,
    evaluatorEffort,
    pinnedProjectId,
    pinnedProjectLabel,
    pinnedSprintId,
    pinnedSprintLabel,
  } = input;

  evict(records, clock());
  const descriptor: SessionDescriptor = {
    id: runner.id,
    flowId,
    title,
    status: runner.status,
    startedAt: clock(),
    trace: runner.trace,
    ...withDefinedFields({
      taskNames,
      maxTurns,
      maxAttempts,
      plannedLeaves,
      planLabelByName,
      terminalSubstepName,
      taskRecovering,
      generatorModel,
      evaluatorModel,
      generatorProvider,
      evaluatorProvider,
      generatorEffort,
      evaluatorEffort,
      pinnedProjectId,
      pinnedProjectLabel,
      pinnedSprintId,
      pinnedSprintLabel,
    }),
  };
  const record: SessionRecord = { descriptor, runner: runner as Runner<unknown> };
  records.set(runner.id, record);
  notify(listeners);

  attachRunnerLifecycle(runner, {
    onStarted: () => update(records, listeners, clock, runner.id, { status: 'running' }),
    onStep: () => touchTrace(records, listeners, runner.id),
    onCompleted: () =>
      update(records, listeners, clock, runner.id, {
        status: 'completed',
        finishedAt: clock(),
        trace: runner.trace,
      }),
    onFailed: (error) =>
      update(records, listeners, clock, runner.id, {
        status: 'failed',
        finishedAt: clock(),
        trace: runner.trace,
        error,
      }),
    onAborted: () =>
      update(records, listeners, clock, runner.id, { status: 'aborted', finishedAt: clock(), trace: runner.trace }),
  });

  return record;
};

export interface SessionManager {
  list(): readonly SessionRecord[];
  get(id: string): SessionRecord | undefined;
  /** Register a runner with the manager. */
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
    readonly generatorProvider?: AiProvider;
    readonly evaluatorProvider?: AiProvider;
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
   * Emergency memory relief: drop EVERY terminal record immediately, ignoring TTL / LRU. Returns the number dropped.
   */
  shedTerminal(): number;
  /** Retroactively pin the sprint on an existing descriptor. */
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
  const records = new Map<string, SessionRecord>();
  const listeners = new Set<SessionListener>();

  return {
    list: () => [...records.values()].sort((a, b) => a.descriptor.startedAt - b.descriptor.startedAt),
    get: (id) => records.get(id),
    register: (input) => {
      opts?.runs?.track(input.runner);
      return registerSession(records, listeners, clock, input);
    },
    abort: (id) => records.get(id)?.runner.abort('user requested'),
    remove: (id) => {
      if (records.delete(id)) notify(listeners);
    },
    shedTerminal: () => shedTerminalRecords(records, listeners),
    setPinnedSprint: (runnerId, sprintId, sprintLabel) =>
      update(records, listeners, clock, runnerId, { pinnedSprintId: sprintId, pinnedSprintLabel: sprintLabel }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
};
