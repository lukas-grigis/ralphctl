import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { Attempt, VerifiedAttempt } from '@src/domain/entity/attempt.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

// Re-exports — these types conceptually belong to Attempt but were historically used
// alongside Task. Kept here for ergonomic imports.
export type {
  Attribution,
  VerifyRun,
  VerifyRunOutcome,
  VerifyRunPhase,
  Evaluation,
  EvaluationStatus,
  Verification,
} from '@src/domain/entity/attempt.ts';

/**
 * Structured "definition of done" entry attached to a {@link Task}.
 *
 *  - `id` is stable within the task (e.g. `C1`, `C2`) — the evaluator cites it verbatim when
 *    grading per-criterion PASS / FAIL and the same id surfaces in `contract.md` and
 *    `evaluation.md` so an operator can trace a failure back to the source criterion.
 *  - `assertion` is the human-readable statement of the check.
 *  - `check` partitions criteria into two operational categories:
 *      `auto`   — the evaluator runs `command` and records the verbatim output as evidence.
 *                 `command` is required (domain invariant on `createTask` / `updateTask`).
 *      `manual` — the evaluator inspects the code / state and cites a specific location as
 *                 evidence. `command` MUST be absent.
 */
export interface VerificationCriterion {
  readonly id: string;
  readonly assertion: string;
  readonly check: 'auto' | 'manual';
  readonly command?: string;
}

interface TaskBase extends Entity<TaskId> {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
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
  /**
   * Verbatim external tracker references inherited from the originating ticket — e.g.
   * `['#123']`, `['!456']`, `['PROJ-7']`. Currently always derived from `Ticket.externalRef`
   * (1:1 ticketId mapping at plan / ideate time), but typed as an array to allow future
   * fan-in (one task synthesised from multiple tickets) without a schema migration.
   *
   * Surfaced in the implement prompt's commit-message trailer (`Refs: #123, #124`) and in the
   * PR / MR body's `## Related issues` section. Absent → no trailer, no entry.
   */
  readonly externalRefs?: readonly string[];
  /**
   * Generator model id the task was originally configured with at the moment a plateau
   * escalation fired. Stamped by the escalation policy in `finalize-gen-eval` together with
   * {@link escalatedToModel}. Together they record that the task escalated exactly once and
   * also serve as the cap — both fields are checked before a second escalation can fire.
   */
  readonly escalatedFromModel?: string;
  /**
   * Generator model id the next attempt's generator leaf must spawn with. Stamped by the
   * escalation policy in `finalize-gen-eval` when a plateau triggers a once-per-task model
   * upgrade. The generator leaf prefers this value over `settings.ai.implement.generator.model`
   * when present; the evaluator role is never affected.
   */
  readonly escalatedToModel?: string;
}

export interface TodoTask extends TaskBase {
  readonly status: 'todo';
}

export interface InProgressTask extends TaskBase {
  readonly status: 'in_progress';
}

/**
 * A done task is structurally guaranteed to carry the verified attempt that proved it done.
 * The variadic-tuple type forces `attempts` to be non-empty AND the last element to be a
 * {@link VerifiedAttempt} — TypeScript rejects any code path producing a `DoneTask` without it.
 */
export interface DoneTask extends Omit<TaskBase, 'attempts'> {
  readonly status: 'done';
  readonly attempts: readonly [...Attempt[], VerifiedAttempt];
  /** 1-indexed pointer into `attempts` — `attempts[finalAttemptN - 1]` is the verified one. */
  readonly finalAttemptN: number;
}

export interface BlockedTask extends TaskBase {
  readonly status: 'blocked';
  readonly blockedReason: string;
}

export type Task = TodoTask | InProgressTask | DoneTask | BlockedTask;

/**
 * Derived from `Task` — adding a new variant flows here automatically.
 * @public
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
