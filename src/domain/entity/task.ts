import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { Attempt, VerifiedAttempt } from '@src/domain/entity/attempt.ts';
import type { TaskBlockerClass } from '@src/domain/signal.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

// Re-export — conceptually belongs to Attempt but is used alongside Task. The sibling
// attempt-owned types are imported from `attempt.ts` directly at every call site.
export type { EvaluationStatus } from '@src/domain/entity/attempt.ts';

/**
 * Structured "definition of done" entry. `id` (`C1`, `C2`, …) is stable within the task and cited
 * verbatim by the evaluator. `auto` criteria require `command` (the evaluator runs it); `manual`
 * criteria must not carry one.
 */
export interface VerificationCriterion {
  readonly id: string;
  readonly assertion: string;
  readonly check: 'auto' | 'manual';
  readonly command?: string;
}

/** `unknown`: on the checklist but never graded. */
export type CriterionStatus = 'passed' | 'failed' | 'unknown';

/** Harness-owned verdict per {@link VerificationCriterion.id}, folded from the evaluator's signal — never from prose. */
export type CriteriaVerdicts = Readonly<Record<string, CriterionStatus>>;

/** One block → unblock cycle's state, archived by `unblockTask` instead of deleted. */
export interface RetiredRun {
  readonly attempts: readonly Attempt[];
  readonly criteriaVerdicts?: CriteriaVerdicts;
  readonly escalatedFromModel?: string;
  readonly escalatedToModel?: string;
  readonly escalatedToEffort?: string;
  readonly escalatedToEvaluatorEffort?: string;
}

/**
 * Rejected diff a block quarantined to git stash, and what the next attempt does with it. Keyed by
 * the deterministic stash message, never a positional `stash@{N}` ref — see `quarantineStashMessage`.
 */
export interface QuarantinedDiff {
  readonly stashMessage: string;
  /** Size of the newest stash entry under {@link stashMessage}, measured at quarantine or unblock. */
  readonly stat?: DiffStat;
  /** How many stash entries share the message — more than one after repeated blocks. */
  readonly entries?: number;
  /** Operator decision at unblock; absent = recorded before the choice existed, which auto-restores. */
  readonly nextAttempt?: 'continue' | 'fresh';
  readonly decidedAt?: IsoTimestamp;
}

interface TaskBase extends Entity<TaskId> {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
  /** Ungraded ids keep their prior verdict. Deliberately absent from the create / update inputs. */
  readonly criteriaVerdicts?: CriteriaVerdicts;
  readonly order: number;
  /** Required: every task is born from refining a ticket. */
  readonly ticketId: TicketId;
  /** Prerequisite tasks that must be `done` before this one is available. */
  readonly dependsOn: readonly TaskId[];
  readonly repositoryId: RepositoryId;
  /** Append-only history of generator–evaluator iterations. Empty until first `startNextAttempt`. */
  readonly attempts: readonly Attempt[];
  /** Cap for `attempts.length`. Once reached, `failCurrentAttempt` transitions to `blocked`. */
  readonly maxAttempts?: number;
  readonly extraDimensions?: readonly string[];
  /** Tracker refs from the ticket (`#123`, `PROJ-7`) — the commit `Refs:` trailer and PR "Related issues". */
  readonly externalRefs?: readonly string[];
  /** Latest rung's source model; re-stamped per climb. `from === to` marks a top-of-ladder nudge. */
  readonly escalatedFromModel?: string;
  /** Model the next generator spawn must use instead of the configured one. */
  readonly escalatedToModel?: string;
  /** Effort the next generator spawn must use (the same-model effort rung). */
  readonly escalatedToEffort?: string;
  /** Evaluator-side effort bump, computed against the evaluator's own ladder. The evaluator model never changes. */
  readonly escalatedToEvaluatorEffort?: string;
  /** Never cleared once set — the once-per-task best-of-N gate `decideEscalation` reads. */
  readonly bestOfNGranted?: true;
  /** N for the NEXT attempt; consumed (cleared) at start-attempt. Not the gate — see {@link bestOfNGranted}. */
  readonly bestOfNGrantedCandidates?: number;
  /** Archive of every block → unblock cycle, oldest first; appended by `unblockTask`. */
  readonly retiredAttempts?: readonly RetiredRun[];
  /**
   * Structured pointer to this task's quarantined rejected diff. Survives the unblock clean restart
   * (unlike `blockedReason`) and is cleared once a restore consumes the stash entry.
   */
  readonly quarantinedDiff?: QuarantinedDiff;
}

export interface TodoTask extends TaskBase {
  readonly status: 'todo';
}

export interface InProgressTask extends TaskBase {
  readonly status: 'in_progress';
}

/** The variadic tuple forces a non-empty `attempts` ending in the {@link VerifiedAttempt} that proved it done. */
export interface DoneTask extends Omit<TaskBase, 'attempts'> {
  readonly status: 'done';
  readonly attempts: readonly [...Attempt[], VerifiedAttempt];
  /** 1-indexed pointer into `attempts` — `attempts[finalAttemptN - 1]` is the verified one. */
  readonly finalAttemptN: number;
}

export interface BlockedTask extends TaskBase {
  readonly status: 'blocked';
  readonly blockedReason: string;
  /**
   * `upstream`: a prerequisite was not done — auto-cleared once it unblocks ({@link isUpstreamBlocked}).
   * `own`: failed on its own merits — never auto-cleared. Replaces a fragile reason-prefix heuristic;
   * legacy entries are inferred at read time.
   */
  readonly blockKind: 'upstream' | 'own';
  /** WHAT caused the block. Inferred by `classifyBlock` when a producer doesn't supply it. */
  readonly blockCause?: BlockCause;
  /** WHO owns the repair. Persisted for humans and future triage; nothing reads it back yet. */
  readonly faultSide?: FaultSide;
  /** The generator's own triage from its `task-blocked` signal; absent on every other block path. */
  readonly blockerClass?: TaskBlockerClass;
  /** Verbatim {@link TaskBlockedSignal.question}. */
  readonly question?: string;
  /** Verbatim {@link TaskBlockedSignal.whatUnblocksMe}. */
  readonly whatUnblocksMe?: string;
}

/**
 * - `generator-self-block`   — `<task-blocked>` (or a signals-contract failure treated as one)
 * - `pre-verify-red`         — the verify gate was red before any generator turn
 * - `post-verify-regression` — a green baseline went red after the generator's diff
 * - `fold-conflict` / `worktree-setup-failure` — parallel-path cherry-pick / setup failures
 * - `budget-exhausted`       — attempt cap reached (plateaus or repeated crashes)
 * - `unknown`                — legacy-read fallback only; new code never picks it
 */
export type BlockCause =
  | 'upstream-dependency'
  | 'generator-self-block'
  | 'pre-verify-red'
  | 'post-verify-regression'
  | 'fold-conflict'
  | 'worktree-setup-failure'
  | 'operator-cancelled'
  | 'budget-exhausted'
  | 'unknown';

/**
 * `model` — the generator's output must change; `harness` — scaffolding (watchdog, fold, cancel,
 * upstream); `environment` — repo/runtime (red baseline, setup, rate limit); `grader` — repeated
 * malformed evaluator output; `unknown` — legacy-read fallback.
 */
export type FaultSide = 'model' | 'harness' | 'environment' | 'grader' | 'unknown';

export type Task = TodoTask | InProgressTask | DoneTask | BlockedTask;

/**
 * Derived from `Task` — adding a new variant flows here automatically.
 */
export type TaskStatus = Task['status'];

export interface TaskCreateInput {
  readonly id?: TaskId;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
  readonly order: number;
  readonly ticketId: TicketId;
  readonly dependsOn?: readonly TaskId[];
  readonly repositoryId: RepositoryId;
  readonly maxAttempts?: number;
  readonly extraDimensions?: readonly string[];
  readonly externalRefs?: readonly string[];
}

export interface TaskUpdateInput {
  readonly name?: string;
  /** `null` clears the description; `undefined` keeps it. */
  readonly description?: string | null;
  readonly steps?: readonly string[];
  readonly verificationCriteria?: readonly VerificationCriterion[];
  readonly dependsOn?: readonly TaskId[];
  readonly repositoryId?: RepositoryId;
  /** `null` clears the cap; `undefined` keeps it. */
  readonly maxAttempts?: number | null;
  /** `null` clears extra dimensions; `undefined` keeps them. */
  readonly extraDimensions?: readonly string[] | null;
  /** `null` clears external refs; `undefined` keeps them. */
  readonly externalRefs?: readonly string[] | null;
}
