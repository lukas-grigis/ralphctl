import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AttemptWarning, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationSignal, LearningEntry } from '@src/domain/signal.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import type { ProposedCommitMessage } from '@src/business/task/run-generator-turn.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';

export type { GenEvalExit, RunTaskVerdict };

/**
 * Context flowing through the implement chain. Optional fields populate as upstream leaves run:
 *  - `sprint` — set by `loadSprintLeaf`.
 *  - `execution` — set by `loadSprintExecutionLeaf`.
 *  - `tasks` — set by `loadTasksLeaf`; mutated by per-task leaves so persistence carries the
 *    latest transitions.
 *  - `progressFile` — absolute path to `<sprintDir>/progress.md`, supplied via `opts.progressFile`
 *    (derived by the launcher); appended to by the `progress-journal` leaves.
 *  - `currentTaskId` / `currentTask` — written by `start-attempt` for the in-flight task; consumed
 *    by gen-eval leaves, `commit-task`, and `settle-attempt`.
 *  - `genEvalTurn` — turn counter inside the gen-eval loop, incremented by `generator` leaf.
 *  - `lastEvaluation` — latest evaluator signal; used by the evaluator leaf for plateau detection.
 *  - `lastExitKind` — set when a gen-eval terminal condition is reached (by `generator` /
 *    `evaluator`) or by `finalize-gen-eval` (budget-exhausted).
 *  - `lastWarning` — derived from gen-eval exit / `lastVerifyResult`; consumed by `settle-attempt`.
 *  - `lastVerdict` — passed/failed/malformed; set by `finalize-gen-eval`.
 *  - `lastBlockReason` — set by `generator` on `self-blocked`; drives `markTaskBlocked`.
 *  - `lastVerifyResult` — set by `post-task-verify`.
 *  - `lastCommitSha` — set by `commit-task` if the tree was dirty and the commit landed.
 *  - `proposedCommitMessage` — generator-emitted `<commit-message>` signal from the latest
 *    turn that produced one. Consumed by `commit-task`'s default message factory. Carries
 *    across turns: when the loop iterates, the latest non-undefined value wins so the final
 *    commit reflects the final accepted state of the work.
 *  - `expectedBranch` — branch name `resolveBranchLeaf` checked out on the working tree.
 *    Stamped after persistence so per-task `branchPreflightLeaf` can short-circuit when the
 *    current ref doesn't match (e.g. the user manually `git checkout`-ed mid-run).
 */
export interface ImplementCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint | undefined;
  readonly execution?: SprintExecution | undefined;
  readonly tasks?: readonly Task[] | undefined;
  readonly progressFile?: AbsolutePath | undefined;
  /**
   * Per-task audit workspace root — `<sprintDir>/implement/<task-id>/`. Set by
   * `buildTaskWorkspaceLeaf` at the start of every per-task sub-chain. The generator/evaluator
   * leaves use this to write `rounds/<N>/…/session.md` and `signals.json` after each turn.
   */
  readonly taskWorkspaceRoot?: AbsolutePath | undefined;
  readonly currentTaskId?: TaskId | undefined;
  readonly currentTask?: Task | undefined;
  readonly genEvalTurn?: number | undefined;
  /**
   * On-disk round folder index for the current gen-eval turn — `rounds/<N>/`. Set by the
   * generator leaf (`max(existing-rounds-on-disk) + 1`) and read by the evaluator leaf so both
   * roles write under the same `<N>`. On a fresh task this equals `genEvalTurn`; on a resumed
   * task it picks up after the highest round already on disk so prior rounds aren't overwritten.
   */
  readonly currentRoundNum?: number | undefined;
  readonly lastEvaluation?: EvaluationSignal | undefined;
  /**
   * Append-only per-task history of completed evaluator turns — fed into the plateau
   * predicate by the evaluator leaf so a configurable window of consecutive turns (see
   * `settings.harness.plateauThreshold`) can be compared, not just the immediate prior one.
   * Reset implicitly per task: a fresh `currentTask` starts with an empty array.
   */
  readonly plateauHistory?: readonly PlateauTurnRecord[] | undefined;
  readonly lastExit?: GenEvalExit | undefined;
  readonly lastVerdict?: RunTaskVerdict | undefined;
  readonly lastBlockReason?: string | undefined;
  readonly lastWarning?: AttemptWarning | undefined;
  /**
   * Set true by `finalize-gen-eval-<taskId>` when the model-escalation policy stamped the
   * current task with `escalatedFromModel`/`escalatedToModel`. Read by
   * `settle-attempt-<taskId>` to fail the running attempt instead of marking the task done —
   * the next chain invocation then re-attempts the task with the escalated generator model.
   * Cleared by settle-attempt along with the rest of the per-task verdict state.
   */
  readonly lastShouldFailAttempt?: boolean | undefined;
  readonly lastVerifyResult?:
    | { readonly kind: 'skipped' }
    | { readonly kind: 'passed' }
    | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
    | undefined;
  /**
   * Outcome of the pre-task-verify leaf for the in-flight task — `'success' | 'failed' |
   * 'spawn-error' | 'skipped'`. Read by `post-task-verify` to compute attribution. Cleared
   * by `settle-attempt` along with the rest of the per-task verdict state.
   */
  readonly lastPreVerifyOutcome?: VerifyRunOutcome | undefined;
  /**
   * Outcome + cwd of the most recent post-task-verify run. Read by the NEXT task's
   * pre-task-verify leaf to decide whether the carried baseline can stand in for re-running
   * the script (short-circuits when `outcome === 'success'`, the cwd matches, and the
   * working tree is clean per `git status --porcelain`). Survives `settle-attempt` — that
   * leaf clears per-attempt fields but this field carries across tasks. Undefined before
   * the first post-task-verify of a sprint.
   */
  readonly priorPostVerifyOutcome?: { readonly cwd: AbsolutePath; readonly outcome: VerifyRunOutcome } | undefined;
  /**
   * Repository ids whose setup script SUCCEEDED during THIS launch's `setup-script-runner` leaf.
   * Distinct from `SprintExecution.setupRanAt` (which persists across launches/resumes): this
   * marker is run-scoped and lives only on ctx, so a prior launch's persisted success does NOT
   * appear here. Set by `setup-script-runner` (it appends a repo id only when the script ran
   * green in this invocation — NOT on the resume-skip path, where the success belongs to an
   * earlier launch). Read by the first `pre-task-verify` of the run (per repo) to seed a green
   * baseline without re-running the verify gate, when `harness.skipPreVerifyOnFreshSetup` is on
   * and the tree is clean. Survives the parallel-path `forkCtx` (run-scoped, like `execution`).
   * Undefined before setup runs / when no setup succeeded this launch.
   */
  readonly setupVerifiedRepoIdsThisRun?: readonly RepositoryId[] | undefined;
  readonly lastCommitSha?: string | undefined;
  readonly proposedCommitMessage?: ProposedCommitMessage | undefined;
  readonly expectedBranch?: string | undefined;
  /**
   * Captured Claude `session_id` from the most recent generator turn of the in-flight task.
   * Threaded into the next round's `implementSession({ resume })` so the generator continues
   * as ONE conversational thread across all gen-eval rounds for this task — instead of paying
   * Claude's full startup cost (cwd discovery, MCP server re-init, system-prompt reprocess)
   * on every spawn. Cleared by `start-attempt-<id>` when a new task begins so the next task
   * starts a fresh "developer."
   *
   * Read from `<workspaceRoot>/rounds/<N>/generator/session-id.txt` per the file-based provider
   * contract — the Claude adapter writes the file via `persistSessionIdFile` after every spawn.
   * Undefined on the first round of a task or when the prior spawn failed before reporting an id.
   */
  readonly priorGeneratorSessionId?: SessionId | undefined;
  /**
   * Captured Claude `session_id` from the most recent evaluator turn of the in-flight task.
   * Mirror of {@link priorGeneratorSessionId} for the reviewer thread. Generator and evaluator
   * are intentionally separate conversational threads: their roles, prompts, and tool budgets
   * differ, and mixing their transcripts via cross-role resume would confuse the model.
   */
  readonly priorEvaluatorSessionId?: SessionId | undefined;
  /**
   * Per-attempt decision accumulator — every `decision` signal the generator/evaluator emits
   * during the gen-eval loop is pushed onto this array by the leaves. Read by
   * `progress-journal-<taskId>` to render the `### Decisions` subsection of the journal
   * entry, then cleared on the same leaf so the next task starts with an empty accumulator.
   * Wave 7 (audit-[07]) replaces the on-disk `decisions.log` sink with this in-memory
   * aggregate.
   */
  readonly currentAttemptDecisions?: readonly string[] | undefined;
  /**
   * Per-attempt `change` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Read by `progress-journal-<taskId>` to render the `### Changes` subsection. Cleared by
   * the journal leaf after the attempt settles.
   */
  readonly currentAttemptChanges?: readonly string[] | undefined;
  /**
   * Per-attempt `learning` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Each entry is a structured {@link LearningEntry} (Insight + optional Context + optional
   * Applies-to). Read by `progress-journal-<taskId>` to render the `### Learnings` subsection
   * and by `append-learnings-<taskId>` to persist the procedural-memory ledger rows. Cleared
   * by the journal leaf after the attempt settles.
   */
  readonly currentAttemptLearnings?: readonly LearningEntry[] | undefined;
  /**
   * Per-attempt `note` signal accumulator — same lifecycle as `currentAttemptDecisions`.
   * Read by `progress-journal-<taskId>` to render the `### Notes` subsection. Cleared by
   * the journal leaf after the attempt settles.
   */
  readonly currentAttemptNotes?: readonly string[] | undefined;
}
