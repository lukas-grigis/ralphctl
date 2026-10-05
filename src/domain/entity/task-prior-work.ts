import { Result } from '@src/domain/result.ts';
import type { Attempt, PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import type {
  BlockCause,
  BlockedTask,
  InProgressTask,
  QuarantinedDiff,
  Task,
  TodoTask,
} from '@src/domain/entity/task.ts';
import { replaceLastAttempt, requireRunningAttempt } from '@src/domain/entity/task-attempts.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Pure rules for a task's quarantined rejected diff ({@link QuarantinedDiff}): what the operator is
 * advised at unblock, how the decision is recorded, how the restore leaf's outcome is stamped, and
 * what the generator is told when a restored draft sits in its working tree.
 */

export type PriorWorkChoice = 'continue' | 'fresh';

/** The operator's answer at unblock, plus what the stash probe measured (absent when it couldn't). */
export interface PriorWorkDecision {
  readonly choice: PriorWorkChoice;
  readonly stashMessage: string;
  readonly stat?: DiffStat;
  readonly entries?: number;
}

/** A decision paired with when it was taken — what {@link decidePriorWork} stamps. */
export interface DatedPriorWorkDecision {
  readonly decision: PriorWorkDecision;
  readonly decidedAt: IsoTimestamp;
}

/** What the generator is told about restored earlier work: its size and the critique that rejected it. */
export interface RestoredWorkContext {
  readonly stat?: DiffStat;
  readonly critique?: string;
}

// Causes that stopped for something other than quality: the diff is worth continuing from.
const CONTINUE_CAUSES: ReadonlySet<BlockCause> = new Set<BlockCause>(['generator-self-block', 'operator-cancelled']);

/**
 * Recommended next-attempt behaviour at unblock. Continue only when the work stopped for a missing
 * answer, an operator cancel, or a stuck `in_progress` run; every other block failed on quality (or
 * is unclassified), and fresh is the non-destructive choice — the stash stays either way.
 */
export const recommendedPriorWork = (task: Task): PriorWorkChoice => {
  if (task.status === 'in_progress') return 'continue';
  if (task.status === 'blocked' && task.blockCause !== undefined && CONTINUE_CAUSES.has(task.blockCause)) {
    return 'continue';
  }
  return 'fresh';
};

const sameStat = (a: DiffStat | undefined, b: DiffStat | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.files === b.files &&
    a.insertions === b.insertions &&
    a.deletions === b.deletions &&
    a.partial === b.partial);

const sameFact = (a: QuarantinedDiff | undefined, b: QuarantinedDiff): boolean =>
  a !== undefined &&
  a.stashMessage === b.stashMessage &&
  a.entries === b.entries &&
  a.nextAttempt === b.nextAttempt &&
  a.decidedAt === b.decidedAt &&
  sameStat(a.stat, b.stat);

/**
 * Record a fresh quarantine on a blocked task. The stat describes the entry just pushed (the newest
 * under the key), so it replaces any earlier one, and a decision from a previous unblock is dropped —
 * the next unblock decides about the new diff. Returns the same object when nothing changed.
 */
export const withQuarantinedDiff = (
  task: BlockedTask,
  stashMessage: string,
  stat?: DiffStat,
  entries?: number
): BlockedTask => {
  const next: QuarantinedDiff = {
    stashMessage,
    ...(stat !== undefined ? { stat } : {}),
    ...(entries !== undefined ? { entries } : {}),
  };
  return sameFact(task.quarantinedDiff, next) ? task : { ...task, quarantinedDiff: next };
};

/**
 * Record the operator's prior-work decision on a `todo` task. A probe that couldn't measure the stash
 * keeps the stat recorded at quarantine time, since the key names the same entry.
 */
export const decidePriorWork = (task: TodoTask, d: PriorWorkDecision, now: IsoTimestamp): TodoTask => {
  const prev = task.quarantinedDiff?.stashMessage === d.stashMessage ? task.quarantinedDiff : undefined;
  const stat = d.stat ?? prev?.stat;
  const entries = d.entries ?? prev?.entries;
  return {
    ...task,
    quarantinedDiff: {
      stashMessage: d.stashMessage,
      ...(stat !== undefined ? { stat } : {}),
      ...(entries !== undefined ? { entries } : {}),
      nextAttempt: d.choice,
      decidedAt: now,
    },
  };
};

/** Drop the quarantined-diff fact — the stash no longer holds the key (consumed or dropped by hand). */
export const clearStaleQuarantinedDiff = <T extends Task>(task: T): T => {
  if (task.quarantinedDiff === undefined) return task;
  const { quarantinedDiff: _cleared, ...rest } = task;
  void _cleared;
  return rest as T;
};

/**
 * Stamp the restore leaf's outcome on the running attempt. `restored` consumed the stash entry, so the
 * task-level fact goes; any other outcome leaves the entry in the stash, so the fact must exist.
 */
export const stampPriorWorkOutcome = (
  task: InProgressTask,
  o: PriorWorkOutcome
): Result<InProgressTask, InvalidStateError> => {
  const running = requireRunningAttempt(task);
  if (!running.ok) return Result.error(running.error);
  const stamped = replaceLastAttempt(task, { ...running.value, priorWork: o });
  if (o.kind === 'restored') return Result.ok(clearStaleQuarantinedDiff(stamped));
  if (stamped.quarantinedDiff !== undefined) return Result.ok(stamped);
  return Result.ok({ ...stamped, quarantinedDiff: { stashMessage: o.stashMessage } });
};

const newestCritique = (attempts: readonly Attempt[]): string | undefined =>
  attempts.findLast((att) => att.critique !== undefined && att.critique.trim().length > 0)?.critique;

/** Newest non-empty critique of the run the last unblock archived — the one that rejected a quarantined diff. */
export const latestRetiredCritique = (task: Task): string | undefined => {
  const retired = task.retiredAttempts?.at(-1);
  return retired === undefined ? undefined : newestCritique(retired.attempts);
};

/**
 * Context for a restored draft that is still uncommitted: walks the live attempts newest → oldest,
 * stops at the first committed one (the draft is no longer the tree's uncommitted state), and answers
 * on a `restored` stamp — the attempt that just popped, or an interrupted earlier one on a cold restart.
 */
export const restoredWorkContext = (task: Task): RestoredWorkContext | undefined => {
  for (let i = task.attempts.length - 1; i >= 0; i--) {
    const att = task.attempts[i];
    if (att === undefined || att.commitSha !== undefined) return undefined;
    if (att.priorWork?.kind === 'restored') {
      const { stat } = att.priorWork;
      const critique = latestRetiredCritique(task);
      return {
        ...(stat !== undefined ? { stat } : {}),
        ...(critique !== undefined ? { critique } : {}),
      };
    }
  }
  return undefined;
};
