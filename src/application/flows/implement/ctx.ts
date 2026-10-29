import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SetupTreeRecord, SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AttemptWarning, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationSignal, LearningEntry } from '@src/domain/signal.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import type { BlockTriageCarry, ProposedCommitMessage } from '@src/business/task/run-generator-turn.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { ReproductionArtifact } from '@src/application/flows/implement/leaves/reproduce.ts';
import type { BestOfNCandidateRecord } from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';

export type { GenEvalExit, RunTaskVerdict };

/**
 * Context flowing through the implement chain; optional fields fill in as leaves run. Each field's
 * merge / reset lifecycle is classified in `sprint-scoped-projection.ts`.
 */
export interface ImplementCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint | undefined;
  readonly execution?: SprintExecution | undefined;
  /** Loaded by `load-tasks`; per-task leaves write their transitions back so `save-tasks` persists them. */
  readonly tasks?: readonly Task[] | undefined;
  readonly progressFile?: AbsolutePath | undefined;
  /** `<sprintDir>/implement/<task-id>/` — set by `build-task-workspace`; holds `rounds/<N>/…`. */
  readonly taskWorkspaceRoot?: AbsolutePath | undefined;
  /** The in-flight task — set by `start-attempt`, cleared by `settle-attempt`. */
  readonly currentTaskId?: TaskId | undefined;
  readonly currentTask?: Task | undefined;
  /** Gen-eval turn counter within the attempt, bumped by the generator. */
  readonly genEvalTurn?: number | undefined;
  /**
   * `rounds/<N>/` index for the current turn, claimed by `resolve-round-num` as max-on-disk + 1 so a
   * resumed task never overwrites a prior round. Both roles read it.
   */
  readonly currentRoundNum?: number | undefined;
  readonly lastEvaluation?: EvaluationSignal | undefined;
  /** Completed evaluator turns this attempt — the plateau predicate's window. */
  readonly plateauHistory?: readonly PlateauTurnRecord[] | undefined;
  readonly lastExit?: GenEvalExit | undefined;
  /** Set by `finalize-gen-eval`. */
  readonly lastVerdict?: RunTaskVerdict | undefined;
  /** Drives `markTaskBlocked` in `settle-attempt`. */
  readonly lastBlockReason?: string | undefined;
  /**
   * The generator's own triage of a `self-blocked` exit, persisted onto the blocked task. A crash
   * block carries none, and each field is optional.
   */
  readonly lastBlockTriage?: BlockTriageCarry | undefined;
  readonly lastWarning?: AttemptWarning | undefined;
  /**
   * Keeps the task `in_progress` at settle (a fresh attempt follows) instead of settling it —
   * set by `finalize-gen-eval` on escalation and by `post-task-verify` on a regressed retry.
   */
  readonly lastShouldFailAttempt?: boolean | undefined;
  /** Set by `post-task-verify`; `stderr` is the full untruncated output. */
  readonly lastVerifyResult?:
    | { readonly kind: 'skipped' }
    | { readonly kind: 'passed' }
    | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
    | undefined;
  /** Pre-task-verify's outcome — `post-task-verify` attributes against it. */
  readonly lastPreVerifyOutcome?: VerifyRunOutcome | undefined;
  /**
   * The last post-task-verify, carried across tasks so the next pre-task-verify can skip the gate
   * on a clean tree when `outcome === 'success'`, the cwd matches and `coveredAllGates` is true.
   * A diff-scoped green only proves the executed gates passed, so it must not stand in for a
   * whole-tree baseline; an absent flag counts as not covered.
   */
  readonly priorPostVerifyOutcome?:
    { readonly cwd: AbsolutePath; readonly outcome: VerifyRunOutcome; readonly coveredAllGates?: boolean } | undefined;
  /**
   * Repos whose setup script ran green in THIS launch (not a resume-skip, unlike the persisted
   * `SprintExecution.setupRanAt`). Lets the run's first pre-task-verify per repo seed a green
   * baseline when `harness.skipPreVerifyOnFreshSetup` is on and the tree is clean.
   */
  readonly setupVerifiedRepoIdsThisRun?: readonly RepositoryId[] | undefined;
  /**
   * Per repo, the main checkout's post-setup tree answer (fresh, or the persisted `SetupRun.tree`
   * on a resume-skip). Each parallel worktree's setup step matches its own output against it.
   */
  readonly setupTreeRecords?: ReadonlyMap<RepositoryId, SetupTreeRecord> | undefined;
  /** Set by `commit-task` when a commit landed. */
  readonly lastCommitSha?: string | undefined;
  /** Latest `<commit-message>` the generator emitted; the last one wins across turns. */
  readonly proposedCommitMessage?: ProposedCommitMessage | undefined;
  /** The branch `resolve-branch` checked out; `branch-preflight` re-asserts it per task. */
  readonly expectedBranch?: string | undefined;
  /**
   * The generator's last session id (read from `rounds/<N>/generator/session-id.txt`), resumed by
   * the next round so the task stays one conversation instead of paying a cold start per spawn.
   */
  readonly priorGeneratorSessionId?: SessionId | undefined;
  /** The evaluator's own thread — never cross-resumed with the generator's. */
  readonly priorEvaluatorSessionId?: SessionId | undefined;
  /**
   * Set by `start-attempt` on a crash resume (the interrupted generator session seeded above): the
   * next generator turn sends the crash-resume prompt, then clears it.
   */
  readonly crashResumePending?: boolean | undefined;
  /**
   * Per-attempt signal accumulators, filled by the gen-eval leaves and rendered by
   * `progress-journal-<taskId>`, which then clears them.
   */
  readonly currentAttemptDecisions?: readonly string[] | undefined;
  readonly currentAttemptChanges?: readonly string[] | undefined;
  /** Also persisted to the learnings ledger by `append-learnings-<taskId>`. */
  readonly currentAttemptLearnings?: readonly LearningEntry[] | undefined;
  readonly currentAttemptNotes?: readonly string[] | undefined;
  /**
   * Corrective `signals.json` nudges this attempt. Nudges consume no turn budget, so this journal
   * count is their only operator-facing surface. Observability only; undefined until the first.
   */
  readonly currentAttemptGeneratorNudges?: number | undefined;
  readonly currentAttemptEvaluatorNudges?: number | undefined;
  /**
   * Provider-reported token totals across both roles' spawns this attempt, persisted by
   * `settle-attempt` (which runs before the journal clears them). Never a substituted `0`.
   */
  readonly currentAttemptInputTokens?: number | undefined;
  readonly currentAttemptOutputTokens?: number | undefined;
  /** Summed AI wall-clock of the same spawns — not the attempt's `finishedAt - startedAt`. */
  readonly currentAttemptDurationMs?: number | undefined;
  /**
   * This project's not-yet-promoted ledger records, loaded once in the prologue and rendered into
   * every generator's full prompt so a later sprint does not re-discover them.
   */
  readonly priorLearnings?: readonly LearningRecord[] | undefined;
  /**
   * The validated reproduction for a defect-shaped task (see `reproduce.ts`), threaded into every
   * gen-eval prompt of the task. Survives the task's attempts; cleared at the start of every task
   * so it never leaks into the next one, and by `restore-blocked-diff` when its test is gone.
   * Undefined whenever no reproduction validated.
   */
  readonly reproductionArtifact?: ReproductionArtifact | undefined;
  /** Best-of-N candidates sampled in place of round 1 of a granted attempt; read by selection. */
  readonly bestOfNCandidates?: readonly BestOfNCandidateRecord[] | undefined;
  /**
   * Candidate slots used, failed ones included — a failed candidate still owns its
   * `candidates/<n>/` dir and stash message, so the next iteration never reuses the index.
   */
  readonly bestOfNSampledCount?: number | undefined;
  /**
   * The best-of-N composite's attempt-scoped turn counter. Its guards read this rather than
   * `currentRoundNum` (claimed per TASK, so ≥3 on any granted attempt) and rather than
   * `task.bestOfNGrantedCandidates`, which `bestOfNSelectionLeaf` clears mid-composite.
   */
  readonly bestOfNLoopTurn?: number | undefined;
  /** Stamped by `bestOfNSelectionLeaf` so the journal records the N sessions spent. */
  readonly bestOfNSummary?:
    { readonly candidatesSampled: number; readonly survivors: number; readonly winnerIndex?: number } | undefined;
}
