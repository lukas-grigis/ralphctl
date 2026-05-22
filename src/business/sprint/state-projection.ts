import type { Attempt, AttemptStatus, Evaluation } from '@src/domain/entity/attempt.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task, TaskStatus } from '@src/domain/entity/task.ts';
import type { Ticket, TicketStatus } from '@src/domain/entity/ticket.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Pure projection from the canonical on-disk sprint state into a normalised view model.
 *
 * The function has two audiences:
 *   1. The `progress.md` snapshot renderer (P1b) — turns the projection into a human-readable
 *      Markdown digest the operator can grep / paste into reports.
 *   2. TUI panels (P1c+) — derive the row sets shown in the dashboard, blocker list, stale-task
 *      banner, dependency-cycle warning, ETA strip, etc.
 *
 * Both audiences share the same upstream state. Duplicating the derivation in the two renderers
 * would drift; centralising it here keeps a single source of truth.
 *
 * No I/O. Callers load `Sprint` / `SprintExecution` / `Task[]` from the repos and `ChainLogEntry[]`
 * from `<sprintDir>/chain.log` (the NDJSON loader lives elsewhere — written in a follow-up so this
 * stays purely a `domain → business` projection).
 *
 * `now` is taken as a parameter so the stale heuristic stays deterministic in tests.
 */

/**
 * Stale threshold for the "no signal in >24h" heuristic. Exported so the future ETA calculator
 * (P3a) can reuse the same cutoff without re-deriving it.
 * @public
 */
export const STALE_THRESHOLD_HOURS = 24;

/**
 * Minimal shape this projection consumes from `<sprintDir>/chain.log`. The on-disk file is JSONL
 * of `AppEvent` lines (see `business/observability/events.ts`); the loader is responsible for
 * normalising those varied shapes into this flat record so the projection only walks one schema.
 *
 * `event` is the discriminator (e.g. `chain-started`, `task-attempt-evaluated`, `log`). `meta` is
 * a free-form bag — variant-specific correlation handles (`taskId`, `sessionId`, …) land here.
 * @public
 */
export interface ChainLogEntry {
  readonly timestamp: IsoTimestamp;
  readonly chainId: string;
  readonly level: string;
  readonly event: string;
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** @public */
export interface SprintStateIdentity {
  readonly id: string;
  readonly name: string;
  readonly activatedAt?: IsoTimestamp;
  readonly reviewAt?: IsoTimestamp;
  readonly doneAt?: IsoTimestamp;
}

/**
 * `effective` differs from `raw` when every non-done task is blocked even though the sprint is
 * still `active` — surfaces "the sprint is wedged" to renderers without changing the persisted
 * status.
 * @public
 */
export interface SprintStateStatus {
  readonly raw: SprintStatus;
  readonly effective: SprintStatus | 'blocked';
}

/** @public */
export interface SprintStateCounts {
  readonly total: number;
  readonly done: number;
  readonly inProgress: number;
  readonly blocked: number;
  readonly todo: number;
}

/**
 * Branch + PR delivery facts. `expected` is the branch the sprint plans to use (today: same as
 * `name`; left as a field so a future "expected vs actual" diff can be shown without a schema
 * migration). `actual` is filled by the caller (repo port not available here) — left undefined
 * when the caller hasn't probed git.
 * @public
 */
export interface SprintStateBranch {
  readonly name: string | undefined;
  readonly pullRequestUrl: string | undefined;
  readonly expected: string | undefined;
  readonly actual?: string;
}

/** @public */
export interface TicketSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly externalRef?: string;
}

/** @public */
export interface TaskLastAttempt {
  readonly n: number;
  readonly status: AttemptStatus;
  readonly verdict?: Evaluation['status'];
  readonly commitSha?: string;
  readonly durationMs?: number;
  readonly critique?: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
}

/**
 * One per-task harness signal carried by a `HarnessSignalEvent` on the chain log. The
 * `progress.md` renderer surfaces these as bulleted sub-sections under each task.
 * @public
 */
export interface TaskSignalEntry {
  readonly at: IsoTimestamp;
  readonly text: string;
}

/** @public */
export interface TaskProjection {
  readonly id: string;
  readonly name: string;
  readonly status: TaskStatus;
  readonly order: number;
  readonly ticketId: string;
  readonly repositoryId: string;
  readonly blockedBy: readonly string[];
  readonly attemptsCount: number;
  readonly lastAttempt?: TaskLastAttempt;
  /** Median of every settled attempt's duration. Undefined when no settled attempt has a duration. */
  readonly medianRoundDurationMs?: number;
  /**
   * Concrete-change signals (`<change>`) emitted for this task, oldest first. Mined from the
   * chain log's `harness-signal` entries. Empty when the task emitted no changes.
   */
  readonly changes: readonly TaskSignalEntry[];
  /**
   * Cross-task knowledge (`<learning>`) emitted for this task, oldest first. Same source as
   * {@link changes}.
   */
  readonly learnings: readonly TaskSignalEntry[];
  /**
   * Incidental observations (`<note>`) emitted for this task, oldest first. Same source as
   * {@link changes}.
   */
  readonly notes: readonly TaskSignalEntry[];
  /**
   * Persisted `blockedReason` when the task is in `blocked` status. Surfaced here so the
   * renderer can show a "why blocked" callout under the task's sub-section without making
   * the renderer reach back into the raw `Task` entity.
   */
  readonly blockReason?: string;
}

/**
 * One blocker the operator should review. Surfaces both structurally-blocked tasks and tasks
 * whose latest attempt settled non-verified (`failed` / `malformed` / `aborted`).
 * @public
 */
export interface BlockerEntry {
  readonly taskId: string;
  readonly name: string;
  readonly reason: 'blocked-status' | 'last-attempt-failed';
  readonly detail: string;
}

/** @public */
export interface StaleEntry {
  readonly taskId: string;
  readonly name: string;
  readonly lastSignalAt?: IsoTimestamp;
  readonly hoursSinceSignal?: number;
}

/**
 * Run boundary derived by grouping chain-log entries by `chainId`. `outcome` is determined by the
 * presence of `chain-completed` / `chain-failed` / `chain-aborted` events; an open run with none
 * of those is `in-progress`.
 * @public
 */
export interface RunBoundary {
  readonly chainId: string;
  readonly flowId?: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly outcome: 'completed' | 'failed' | 'aborted' | 'in-progress';
  readonly stepsCompleted: number;
  readonly stepsFailed: number;
}

/**
 * A decision pulled from the chain log. Today no prompt emits a `decision` signal — the entry is
 * forward-compat for P3d once the prompts adapter starts publishing decisions onto the bus.
 * @public
 */
export interface DecisionEntry {
  readonly chainId: string;
  readonly at: IsoTimestamp;
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** @public */
export interface SprintState {
  readonly identity: SprintStateIdentity;
  readonly status: SprintStateStatus;
  readonly counts: SprintStateCounts;
  readonly branch: SprintStateBranch;
  readonly tickets: readonly TicketSummary[];
  readonly tasks: readonly TaskProjection[];
  readonly blockers: readonly BlockerEntry[];
  readonly staleTasks: readonly StaleEntry[];
  readonly dependencyCycles: ReadonlyArray<readonly string[]>;
  readonly decisions: readonly DecisionEntry[];
  readonly runs: readonly RunBoundary[];
  readonly lastRun?: RunBoundary;
}

/** @public */
export interface ProjectSprintStateInput {
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
  readonly tasks: readonly Task[];
  readonly chainLogEntries: readonly ChainLogEntry[];
  readonly now: IsoTimestamp;
  /** Optional branch probe result, when the caller has it. Threads into `branch.actual`. */
  readonly actualBranch?: string;
  /**
   * Authoritative decision entries loaded from `<sprintDir>/decisions.log`. When present,
   * these are merged with any in-band decisions mined from the chain log so the
   * `## Decisions` section in `progress.md` reflects both sources. Empty / undefined →
   * the projection falls back to the chain-log-mined decisions only.
   */
  readonly decisionsLogEntries?: readonly DecisionEntry[];
}

/**
 * Project the supplied sprint subgraph into a normalised, renderable view model.
 *
 * Total over its inputs — no `Result<…>` envelope. Synthetic / fallback values are used when an
 * input is missing (e.g. a 0-task sprint produces `total: 0` and no blockers / cycles).
 * @public
 */
export const projectSprintState = (input: ProjectSprintStateInput): SprintState => {
  const { sprint, execution, tasks, chainLogEntries, now, actualBranch, decisionsLogEntries } = input;

  const counts = countTasks(tasks);
  const status = synthesiseStatus(sprint.status, counts);
  const tasksProjected = tasks.map((t) => projectTask(t, chainLogEntries));
  const blockers = collectBlockers(tasks);
  const dependencyCycles = findCycles(tasks);
  const runs = groupRuns(chainLogEntries);
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
  const decisions = mergeDecisions(collectDecisions(chainLogEntries), decisionsLogEntries);
  const staleTasks = collectStaleTasks(tasks, chainLogEntries, now);

  return {
    identity: identityOf(sprint),
    status,
    counts,
    branch: {
      name: execution.branch ?? undefined,
      pullRequestUrl: execution.pullRequestUrl ?? undefined,
      expected: execution.branch ?? undefined,
      ...(actualBranch !== undefined ? { actual: actualBranch } : {}),
    },
    tickets: sprint.tickets.map(summariseTicket),
    tasks: tasksProjected,
    blockers,
    staleTasks,
    dependencyCycles,
    decisions,
    runs,
    ...(lastRun !== undefined ? { lastRun } : {}),
  };
};

// ───────────────────────── identity / counts / status ─────────────────────────

const identityOf = (sprint: Sprint): SprintStateIdentity => {
  const out: {
    -readonly [K in keyof SprintStateIdentity]: SprintStateIdentity[K];
  } = { id: sprint.id, name: sprint.name };
  if (sprint.activatedAt !== null) out.activatedAt = sprint.activatedAt;
  if (sprint.reviewAt !== null) out.reviewAt = sprint.reviewAt;
  if (sprint.doneAt !== null) out.doneAt = sprint.doneAt;
  return out;
};

const countTasks = (tasks: readonly Task[]): SprintStateCounts => {
  let done = 0;
  let inProgress = 0;
  let blocked = 0;
  let todo = 0;
  for (const t of tasks) {
    if (t.status === 'done') done++;
    else if (t.status === 'in_progress') inProgress++;
    else if (t.status === 'blocked') blocked++;
    else todo++;
  }
  return { total: tasks.length, done, inProgress, blocked, todo };
};

/**
 * Effective-status synthesis: an active sprint with at least one non-done task, where every
 * non-done task is `blocked`, surfaces as `effective: 'blocked'` even though the persisted status
 * stays `active`. Preserves a 0.6.3 dashboard strength without requiring a domain state change.
 */
const synthesiseStatus = (raw: SprintStatus, counts: SprintStateCounts): SprintStateStatus => {
  const remaining = counts.total - counts.done;
  if (raw === 'active' && remaining > 0 && counts.blocked === remaining) {
    return { raw, effective: 'blocked' };
  }
  return { raw, effective: raw };
};

const summariseTicket = (ticket: Ticket): TicketSummary => ({
  id: ticket.id,
  title: ticket.title,
  status: ticket.status,
  ...(ticket.externalRef !== undefined ? { externalRef: ticket.externalRef } : {}),
});

// ───────────────────────── per-task projection ─────────────────────────

const projectTask = (task: Task, chainLogEntries: readonly ChainLogEntry[]): TaskProjection => {
  const last = task.attempts[task.attempts.length - 1];
  const lastAttempt = last !== undefined ? summariseAttempt(last) : undefined;
  const median = medianSettledDurationMs(task.attempts);
  const changes = collectPerTaskSignals(chainLogEntries, task.id, 'change');
  const learnings = collectPerTaskSignals(chainLogEntries, task.id, 'learning');
  const notes = collectPerTaskSignals(chainLogEntries, task.id, 'note');
  const blockReason = task.status === 'blocked' ? task.blockedReason : undefined;
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    order: task.order,
    ticketId: task.ticketId,
    repositoryId: task.repositoryId,
    blockedBy: task.dependsOn.map(String),
    attemptsCount: task.attempts.length,
    ...(lastAttempt !== undefined ? { lastAttempt } : {}),
    ...(median !== undefined ? { medianRoundDurationMs: median } : {}),
    changes,
    learnings,
    notes,
    ...(blockReason !== undefined ? { blockReason } : {}),
  };
};

/**
 * Filter chain-log entries down to the `harness-signal` rows for one task + kind, then
 * project each into a {@link TaskSignalEntry}. Entries are returned in document order
 * (oldest first) so renderers can stream them top-down.
 *
 * Entries that don't carry a matching `meta.taskId` are skipped — un-attributed signals
 * don't belong under any specific task's heading.
 * @public
 */
export const collectPerTaskSignals = (
  entries: readonly ChainLogEntry[],
  taskId: string,
  kind: 'change' | 'learning' | 'note'
): readonly TaskSignalEntry[] => {
  const out: TaskSignalEntry[] = [];
  for (const entry of entries) {
    if (entry.event !== 'harness-signal') continue;
    if (entry.meta?.['signalKind'] !== kind) continue;
    if (entry.meta?.['taskId'] !== taskId) continue;
    if (entry.message.length === 0) continue;
    out.push({ at: entry.timestamp, text: entry.message });
  }
  return out;
};

const summariseAttempt = (att: Attempt): TaskLastAttempt => {
  const finishedAt = att.status === 'running' ? undefined : att.finishedAt;
  const durationMs =
    finishedAt !== undefined ? new Date(finishedAt).getTime() - new Date(att.startedAt).getTime() : undefined;
  return {
    n: att.n,
    status: att.status,
    ...(att.evaluation !== undefined ? { verdict: att.evaluation.status } : {}),
    ...(att.commitSha !== undefined ? { commitSha: String(att.commitSha) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(att.critique !== undefined ? { critique: att.critique } : {}),
    startedAt: att.startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
};

/**
 * Median of every settled attempt's `finishedAt - startedAt`. Returns `undefined` if no attempt
 * has settled (e.g. brand-new task with one running attempt). Odd-length → middle value;
 * even-length → mean of the two middles.
 */
const medianSettledDurationMs = (attempts: readonly Attempt[]): number | undefined => {
  const durations: number[] = [];
  for (const att of attempts) {
    if (att.status === 'running') continue;
    durations.push(new Date(att.finishedAt).getTime() - new Date(att.startedAt).getTime());
  }
  if (durations.length === 0) return undefined;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  if (durations.length % 2 === 1) return durations[mid];
  const lo = durations[mid - 1];
  const hi = durations[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : undefined;
};

// ───────────────────────── blockers ─────────────────────────

const collectBlockers = (tasks: readonly Task[]): readonly BlockerEntry[] => {
  const out: BlockerEntry[] = [];
  for (const task of tasks) {
    if (task.status === 'blocked') {
      out.push({
        taskId: task.id,
        name: task.name,
        reason: 'blocked-status',
        detail: task.blockedReason,
      });
      continue;
    }
    const last = task.attempts[task.attempts.length - 1];
    if (last === undefined) continue;
    if (last.status === 'failed' || last.status === 'malformed' || last.status === 'aborted') {
      out.push({
        taskId: task.id,
        name: task.name,
        reason: 'last-attempt-failed',
        detail: `attempt n=${last.n} settled as '${last.status}'`,
      });
    }
  }
  return out;
};

// ───────────────────────── stale heuristic ─────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Walk chain log entries and flag any non-done task whose most recent reference is older than
 * {@link STALE_THRESHOLD_HOURS}. A task is "referenced" by an entry whose `meta.taskId` matches
 * its id OR whose `message` contains the id or task name as a substring. The substring match is
 * a deliberately loose fallback for log lines that don't pin a structured `taskId` — false
 * positives here are cheap (a stale task gets unflagged) compared to false negatives (a stale
 * task stays hidden).
 *
 * Tasks with no signal at all but in non-`todo` status are also flagged — they're stale by
 * virtue of having been started but having no follow-up trace.
 */
const collectStaleTasks = (
  tasks: readonly Task[],
  entries: readonly ChainLogEntry[],
  now: IsoTimestamp
): readonly StaleEntry[] => {
  const nowMs = new Date(now).getTime();
  const out: StaleEntry[] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const lastTs = latestSignalForTask(task, entries);
    if (lastTs === undefined) {
      if (task.status !== 'todo') {
        out.push({ taskId: task.id, name: task.name });
      }
      continue;
    }
    const ageHours = (nowMs - new Date(lastTs).getTime()) / MS_PER_HOUR;
    if (ageHours > STALE_THRESHOLD_HOURS) {
      out.push({
        taskId: task.id,
        name: task.name,
        lastSignalAt: lastTs,
        hoursSinceSignal: ageHours,
      });
    }
  }
  return out;
};

const latestSignalForTask = (task: Task, entries: readonly ChainLogEntry[]): IsoTimestamp | undefined => {
  let latest: IsoTimestamp | undefined;
  let latestMs = -Infinity;
  for (const entry of entries) {
    if (!entryMentionsTask(entry, task)) continue;
    const ms = new Date(entry.timestamp).getTime();
    if (ms > latestMs) {
      latestMs = ms;
      latest = entry.timestamp;
    }
  }
  return latest;
};

const entryMentionsTask = (entry: ChainLogEntry, task: Task): boolean => {
  const metaTaskId = entry.meta?.['taskId'];
  if (typeof metaTaskId === 'string' && metaTaskId === task.id) return true;
  if (entry.message.includes(task.id)) return true;
  if (task.name.length > 0 && entry.message.includes(task.name)) return true;
  return false;
};

// ───────────────────────── dependency cycle detection ─────────────────────────

/**
 * Return every distinct cycle in the `dependsOn` graph. A "cycle" is the sequence of task ids
 * traversed back to the start node, in the order encountered (matches 0.6.3's existing renderer).
 *
 * Orphan-dep refs (a `dependsOn` pointing at an id NOT present in the task set) are synthesised
 * as single-element cycles — they're unresolvable references but the renderer should surface
 * them in the same panel as real cycles. This mirrors the 0.6.3 behaviour.
 */
const findCycles = (tasks: readonly Task[]): ReadonlyArray<readonly string[]> => {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(String(t.id), t);

  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const recordCycle = (cycle: readonly string[]): void => {
    if (cycle.length === 0) return;
    const key = canonicalCycleKey(cycle);
    if (seenCycle.has(key)) return;
    seenCycle.add(key);
    cycles.push([...cycle]);
  };

  // Orphan-dep refs → synthesised single-element cycle.
  for (const task of tasks) {
    for (const depRaw of task.dependsOn) {
      const dep = String(depRaw);
      if (!byId.has(dep)) recordCycle([dep]);
    }
  }

  // DFS with on-stack colouring, scanning every unvisited node so disconnected cycles are found.
  const color = new Map<string, 0 | 1 | 2>();
  for (const t of tasks) color.set(String(t.id), 0);

  const stack: string[] = [];
  const dfs = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const depRaw of node.dependsOn) {
        const dep = String(depRaw);
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          const start = stack.indexOf(dep);
          if (start !== -1) recordCycle(stack.slice(start));
        } else if (c === 0) {
          dfs(dep);
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const t of tasks) {
    const id = String(t.id);
    if ((color.get(id) ?? 0) === 0) dfs(id);
  }

  return cycles;
};

/**
 * Canonicalise a cycle to a key invariant under rotation, so the same cycle discovered from two
 * different starting nodes collapses to one entry. We rotate so the lexicographically smallest id
 * leads, then join.
 */
const canonicalCycleKey = (cycle: readonly string[]): string => {
  if (cycle.length === 0) return '';
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    const candidate = cycle[i];
    const current = cycle[minIdx];
    if (candidate !== undefined && current !== undefined && candidate < current) minIdx = i;
  }
  const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
  return rotated.join('→');
};

// ───────────────────────── chain log: runs + decisions ─────────────────────────

/**
 * Group entries by `chainId`, ordered by first-seen `startedAt`. Each group produces one
 * `RunBoundary` carrying the outcome derived from terminal events (`chain-completed` /
 * `chain-failed` / `chain-aborted`). A run with no terminal event is `in-progress` — the runner
 * either crashed mid-flight or is still running while this projection is being computed.
 */
const groupRuns = (entries: readonly ChainLogEntry[]): readonly RunBoundary[] => {
  type RunAcc = {
    chainId: string;
    flowId: string | undefined;
    startedAt: IsoTimestamp;
    finishedAt: IsoTimestamp | undefined;
    outcome: RunBoundary['outcome'];
    stepsCompleted: number;
    stepsFailed: number;
    /** Insertion order — used to sort the output. */
    seq: number;
  };

  const byChain = new Map<string, RunAcc>();
  let seq = 0;
  for (const entry of entries) {
    let run = byChain.get(entry.chainId);
    if (run === undefined) {
      run = {
        chainId: entry.chainId,
        flowId: undefined,
        startedAt: entry.timestamp,
        finishedAt: undefined,
        outcome: 'in-progress',
        stepsCompleted: 0,
        stepsFailed: 0,
        seq: seq++,
      };
      byChain.set(entry.chainId, run);
    } else if (new Date(entry.timestamp).getTime() < new Date(run.startedAt).getTime()) {
      run.startedAt = entry.timestamp;
    }

    if (entry.event === 'chain-started') {
      const flowId = entry.meta?.['flowId'];
      if (typeof flowId === 'string') run.flowId = flowId;
    } else if (entry.event === 'chain-step-completed') {
      run.stepsCompleted++;
    } else if (entry.event === 'chain-step-failed') {
      run.stepsFailed++;
    } else if (entry.event === 'chain-completed') {
      run.outcome = 'completed';
      run.finishedAt = entry.timestamp;
    } else if (entry.event === 'chain-failed') {
      run.outcome = 'failed';
      run.finishedAt = entry.timestamp;
    } else if (entry.event === 'chain-aborted') {
      run.outcome = 'aborted';
      run.finishedAt = entry.timestamp;
    }
  }

  return [...byChain.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((run) => ({
      chainId: run.chainId,
      ...(run.flowId !== undefined ? { flowId: run.flowId } : {}),
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      outcome: run.outcome,
      stepsCompleted: run.stepsCompleted,
      stepsFailed: run.stepsFailed,
    }));
};

/**
 * Merge decisions from two sources: those mined from the chain log (in-band) and those loaded
 * authoritatively from `<sprintDir>/decisions.log`. Duplicates (same `at` + `message`) are
 * collapsed; the decisions-log entry wins on tie because it carries the authoritative columns
 * (taskId / commitSha) the chain log can't reconstruct. Output is sorted by `at` ascending so
 * the rendered `## Decisions` section reads chronologically.
 */
const mergeDecisions = (
  fromChainLog: readonly DecisionEntry[],
  fromDecisionsLog: readonly DecisionEntry[] | undefined
): readonly DecisionEntry[] => {
  if (fromDecisionsLog === undefined || fromDecisionsLog.length === 0) return fromChainLog;
  const dedupKey = (d: DecisionEntry): string => `${String(d.at)}|${d.message}`;
  const merged = new Map<string, DecisionEntry>();
  for (const d of fromChainLog) merged.set(dedupKey(d), d);
  for (const d of fromDecisionsLog) merged.set(dedupKey(d), d); // decisions-log wins on tie
  return [...merged.values()].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
};

/**
 * Defence-in-depth cap on the message length tolerated when mining decisions from the chain
 * log. Mirrors the parser (`integration/ai/signals/decision/parser.ts`) and sink
 * (`integration/observability/sinks/decisions-log-sink.ts`) caps: anything longer than this
 * is a runaway entry from a stray open tag and gets dropped rather than surfaced.
 */
const MAX_DECISION_MESSAGE_CHARS = 500;

/**
 * Mine "decision" entries from the chain log. The current contract: an entry whose `event` field
 * is exactly `'decision'`, or whose `meta.signalKind === 'decision'`. The authoritative source
 * for AI-emitted `<decision>` signals is `<sprintDir>/decisions.log` (see
 * `decisions-log-sink.ts`); this miner is a fallback for events that landed in the chain log
 * via the bus rather than via the decisions sink.
 *
 * Entries whose `message` exceeds {@link MAX_DECISION_MESSAGE_CHARS} are dropped — the parser
 * and sink both clamp upstream, but the miner is the last line of defence for entries that
 * landed pre-cap (legacy log files).
 */
const collectDecisions = (entries: readonly ChainLogEntry[]): readonly DecisionEntry[] => {
  const out: DecisionEntry[] = [];
  for (const entry of entries) {
    const kind = entry.meta?.['signalKind'];
    const isDecision = entry.event === 'decision' || kind === 'decision';
    if (!isDecision) continue;
    if (entry.message.length > MAX_DECISION_MESSAGE_CHARS) continue;
    out.push({
      chainId: entry.chainId,
      at: entry.timestamp,
      message: entry.message,
      ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
    });
  }
  return out;
};
