import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { Attempt, VerifiedAttempt } from '@src/domain/entity/attempt.ts';
import type { TaskBlockerClass } from '@src/domain/signal.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

// Re-export — conceptually belongs to Attempt but is used alongside Task. The sibling
// attempt-owned types are imported from `attempt.ts` directly at every call site.
export type { EvaluationStatus } from '@src/domain/entity/attempt.ts';

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

/**
 * Durable per-criterion verdict the HARNESS owns. `unknown` is the slot for a criterion that has
 * a place on the checklist but no graded verdict yet (never evaluated, or not graded this round).
 * @public
 */
export type CriterionStatus = 'passed' | 'failed' | 'unknown';

/**
 * Harness-owned map of {@link VerificationCriterion.id} → {@link CriterionStatus}. Folded at settle
 * time from the evaluator's structured `criteria` signal (`domain/signal.ts`) — NEVER derived from
 * agent prose. Lets a task with many criteria resume against a k-of-N checklist instead of
 * collapsing to one binary status. Absent until the first evaluator round folds a verdict on.
 * @public
 */
export type CriteriaVerdicts = Readonly<Record<string, CriterionStatus>>;

/**
 * One block → unblock cycle's archived state — the attempts, per-criterion verdicts, and
 * escalation stamps `unblockTask` (`task-lifecycle.ts`) clears off the live task fields when it
 * resets the budget for a clean restart. Recorded here instead of deleted, so the forensic record
 * (what happened before the operator intervened) survives even though the live attempt ledger and
 * verdict checklist start fresh. See {@link TaskBase.retiredAttempts}.
 * @public
 */
export interface RetiredRun {
  readonly attempts: readonly Attempt[];
  readonly criteriaVerdicts?: CriteriaVerdicts;
  readonly escalatedFromModel?: string;
  readonly escalatedToModel?: string;
  readonly escalatedToEffort?: string;
  readonly escalatedToEvaluatorEffort?: string;
}

interface TaskBase extends Entity<TaskId> {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
  /**
   * Durable per-criterion PASS / FAIL state, HARNESS-owned. Folded at settle time from the
   * evaluator's structured `criteria` signal (keyed by {@link VerificationCriterion.id}); ids not
   * graded a given round keep their prior verdict. Absent until the first evaluator round folds.
   * Never planner- or operator-authored — it is excluded from {@link TaskCreateInput} /
   * {@link TaskUpdateInput} on purpose.
   */
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
   * Generator model id the most-recent rung transition climbed FROM. Stamped by the escalation
   * policy in `finalize-gen-eval` together with {@link escalatedToModel}. These fields are
   * re-stampable: the graduated ladder may climb several rungs across successive plateaus, and
   * each climb overwrites the pair with the latest transition. They are NOT the escalation cap —
   * the cap is policy-enforced (top of the ladder plus `maxAttempts`). When `escalatedFromModel
   * === escalatedToModel` the stamp marks a top-of-ladder same-model nudge rather than a bump.
   */
  readonly escalatedFromModel?: string;
  /**
   * Generator model id the next attempt's generator leaf must spawn with — the rung the
   * most-recent transition climbed TO. Stamped by the escalation policy in `finalize-gen-eval`
   * on each plateau-driven rung change (re-stampable across rungs). The generator leaf prefers
   * this value over `settings.ai.implement.generator.model` when present; the evaluator role is
   * never affected.
   */
  readonly escalatedToModel?: string;
  /**
   * Reasoning-effort level the next attempt's generator leaf must spawn with — stamped by the
   * escalation policy's same-model EFFORT rung (`escalate-effort`) when the generator has reached
   * the top of the model ladder but still has effort headroom below `high`. Re-stampable, though
   * the rung fires at most once per task (the next plateau sees the raised effort and falls through
   * to the nudge). The generator leaf prefers this value over the configured `effort` when present;
   * the model itself is unchanged, so this is orthogonal to {@link escalatedToModel}. The evaluator
   * role is never affected.
   */
  readonly escalatedToEffort?: string;
  /**
   * Reasoning-effort level the next attempt's evaluator leaf must spawn with — the evaluator-side
   * counterpart of {@link escalatedToEffort}. Stamped by the escalation policy's same-model EFFORT
   * rung alongside the generator stamp, computed independently against the evaluator's OWN
   * provider/model ladder (never copied from the generator's target). Effort only — the evaluator
   * MODEL never changes, so this field has no `escalatedToModel`-shaped counterpart. The evaluator
   * leaf prefers this value over the configured evaluator effort when present.
   */
  readonly escalatedToEvaluatorEffort?: string;
  /**
   * Permanent "a best-of-N attempt has been granted to this task" marker — stamped once by
   * `recordTaskBestOfNGrant` in `task-settle.ts` when the escalation policy's opt-in top-of-ladder
   * `best-of-n` remedy fires (research: arXiv 2604.16529 — harness-level N-candidate selection).
   * NEVER cleared once set — this is what `decideEscalation` reads to enforce the once-per-task
   * guarantee (a granted attempt that later fails routes the next walk to `topped-out`, never
   * re-grants). Independent of {@link bestOfNGrantedCandidates} below, which a later attempt-body
   * increment may clear once consumed.
   */
  readonly bestOfNGranted?: true;
  /**
   * Candidate count (N) granted to the task's NEXT attempt — the transient handshake value the
   * attempt-body reads at start-attempt to detect "this attempt should sample N candidates and
   * select by verification then judging," then clears back to `undefined` once consumed. The
   * once-per-task gate does NOT depend on this field being cleared — it reads the permanent
   * {@link bestOfNGranted} marker instead, so the gate stays correct even before a later increment
   * wires the consuming/clearing side.
   */
  readonly bestOfNGrantedCandidates?: number;
  /**
   * Archive of every block → unblock cycle this task has been through, oldest first. Appended to
   * (never overwritten) by `unblockTask` — the reset that clears `attempts`, `criteriaVerdicts` and
   * the escalation stamps for a clean restart moves that state here instead of discarding it, so
   * the forensic record survives. Absent until the task's first unblock. `foldOutcomeStats`
   * (`business/runs/outcome-stats.ts`) folds each entry's `attempts` alongside the live `attempts`
   * array so a cleared history keeps counting towards the outcome report.
   */
  readonly retiredAttempts?: readonly RetiredRun[];
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
  /**
   * Structural discriminant for WHY the task is blocked — the only reliable basis for deciding
   * whether the block auto-clears:
   *
   *  - `upstream` — a prerequisite (`dependsOn`) was not `done`, so the dependency gate cascade-
   *    blocked this task. Mechanically clearable: `unblockTaskUseCase` auto-clears it once the root
   *    prerequisite unblocks / completes. {@link isUpstreamBlocked} reads this.
   *  - `own`      — the task failed on its own merits (eval / verify / budget / fold conflict /
   *    operator cancel). Never auto-cleared — it needs the operator to actually fix something.
   *
   * Replaces the fragile `blockedReason.startsWith('blocked upstream')` heuristic: an own-failure
   * reason that happened to begin with that text would have been mis-classified as auto-clearable.
   * Legacy entries lacking the field are inferred at read time from the reason prefix (see the task
   * schema's read-time migration); the canonical shape lands on the next save.
   */
  readonly blockKind: 'upstream' | 'own';
  /**
   * WHAT specifically caused the block — a closed, countable refinement of {@link blockKind} (which
   * only says "upstream" vs "own"). Every real cause the harness produces has a member; `unknown`
   * is the legacy-read fallback (see {@link CriterionStatus} for the same "unclassified slot"
   * pattern), never something new code should choose deliberately:
   *
   *  - `upstream-dependency`     — mirrors `blockKind: 'upstream'`.
   *  - `generator-self-block`    — the generator emitted `<task-blocked>` (or a signals-contract
   *    failure was treated as one) with no more specific classification available.
   *  - `pre-verify-red`          — the harness's independent verify gate was already red BEFORE
   *    any generator turn ran this attempt.
   *  - `post-verify-regression`  — a green baseline went red AFTER the generator's diff.
   *  - `fold-conflict`           — the parallel path's worktree branch could not land on the
   *    shared sprint branch (cherry-pick conflict).
   *  - `worktree-setup-failure`  — the parallel path's per-worktree setup script failed.
   *  - `operator-cancelled`      — the operator explicitly stopped the run and marked it blocked.
   *  - `budget-exhausted`        — `attempts.length` reached the effective cap with no terminal
   *    verdict (whether the attempts were spent on quality plateaus or on repeated process crashes).
   *
   * Orthogonal to {@link faultSide}: this says WHAT happened, `faultSide` says WHO owns the repair.
   * Optional — several block-producing call sites construct a `BlockedTask` without classifying it
   * (a legacy on-disk entry, or a domain helper outside this module); `markTaskBlocked` and the task
   * persistence codec both infer it via `classifyBlock` / `inferBlockCause` (`task-lifecycle.ts`)
   * when the caller doesn't supply it explicitly, so it is populated in practice even when a
   * producer never mentions it. Never throws, never needs a migration pass.
   */
  readonly blockCause?: BlockCause;
  /**
   * WHO the repair belongs to — orthogonal to {@link blockCause} (WHAT happened). Lets the
   * escalation policy (`business/task/escalation-policy.ts`) and any future triage surface skip
   * spending a model-competency remedy (a model bump, an effort raise, a change-of-approach nudge)
   * on a failure the model never caused:
   *
   *  - `model`       — the generator's own output is what needs to change (a self-block, a real
   *    post-verify regression, plain budget exhaustion after genuine quality plateaus).
   *  - `harness`     — the harness's own scaffolding is what needs to change (a watchdog kill, a
   *    fold conflict, an operator cancel, an upstream-dependency cascade).
   *  - `environment` — the repo / runtime state is what needs to change (a pre-existing red
   *    baseline, a worktree setup-script failure, a rate-limit exhaustion).
   *  - `grader`      — the EVALUATOR is what needs to change (repeated malformed evaluator output
   *    burning the attempt budget — see {@link SettleAttemptProps.verdict} in `settle-attempt.ts`).
   *  - `unknown`     — legacy-read fallback, same rationale as `blockCause`'s `unknown` member.
   *
   * Optional for the same reason as {@link blockCause} — inferred via `classifyBlock` when a caller
   * doesn't supply it, defaulted per-`blockCause` (`defaultFaultSideFor`) and, where the caller has
   * definitive crash forensics (an `AbortCause` from a killed AI process), overridden from that
   * instead of guessed from prose (`faultSideForAbortCause`).
   */
  readonly faultSide?: FaultSide;
  /**
   * The GENERATOR's OWN structured triage for why it couldn't proceed — see {@link TaskBlockerClass}
   * in `domain/signal.ts`. Orthogonal to {@link blockCause} (the HARNESS's structural classification
   * of WHICH block-producing code path fired, applying to every block): this is the model's own
   * read of the information gap, set only when the block came from a generator `task-blocked`
   * signal that supplied it. Absent for every non-self-block path (upstream cascade, verify-gate
   * red, fold conflict, operator cancel) and for a self-block whose signal omitted it — all three
   * fields on the signal are optional, so a legacy or minimal `task-blocked` emission still blocks
   * the task, just without this extra structure.
   */
  readonly blockerClass?: TaskBlockerClass;
  /**
   * The single concrete question the generator said, answered, would unblock it — verbatim from
   * {@link TaskBlockedSignal.question} in `domain/signal.ts`. Absent under the same conditions as
   * {@link blockerClass}.
   */
  readonly question?: string;
  /**
   * What the generator said the operator (or a future session) needs to supply or decide to
   * unblock the task — verbatim from {@link TaskBlockedSignal.whatUnblocksMe}. Absent under the
   * same conditions as {@link blockerClass}.
   */
  readonly whatUnblocksMe?: string;
}

/**
 * Closed set of harness-recognised block causes — see {@link BlockedTask.blockCause}. `unknown` is
 * the tolerant-read fallback member, mirroring {@link CriterionStatus}'s `unknown` slot — never a
 * deliberate choice by new code.
 * @public
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
 * Closed set of "where the repair belongs" attributions — see {@link BlockedTask.faultSide}.
 * `unknown` is the tolerant-read fallback member, same rationale as {@link BlockCause}'s.
 * @public
 */
export type FaultSide = 'model' | 'harness' | 'environment' | 'grader' | 'unknown';

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
