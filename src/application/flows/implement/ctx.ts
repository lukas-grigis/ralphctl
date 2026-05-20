import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AttemptWarning, CheckRunOutcome } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import type { ProposedCommitMessage } from '@src/business/task/run-generator-turn.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';

export type { GenEvalExit, RunTaskVerdict };

/**
 * Context flowing through the implement chain. Optional fields populate as upstream leaves run:
 *  - `sprint` — set by `loadSprintLeaf`.
 *  - `execution` — set by `loadSprintExecutionLeaf`.
 *  - `tasks` — set by `loadTasksLeaf`; mutated by per-task leaves so persistence carries the
 *    latest transitions.
 *  - `progressFile` — absolute path to `<sprintDir>/progress.md`, set by `ensureProgressFileLeaf`.
 *  - `currentTaskId` / `currentTask` — written by `start-attempt` for the in-flight task; consumed
 *    by gen-eval leaves, `commit-task`, and `settle-attempt`.
 *  - `genEvalTurn` — turn counter inside the gen-eval loop, incremented by `generator` leaf.
 *  - `lastEvaluation` — latest evaluator signal; used by the evaluator leaf for plateau detection.
 *  - `lastExitKind` — set when a gen-eval terminal condition is reached (by `generator` /
 *    `evaluator`) or by `finalize-gen-eval` (budget-exhausted).
 *  - `lastWarning` — derived from gen-eval exit / `lastVerifyResult`; consumed by `settle-attempt`.
 *  - `lastVerdict` — passed/failed/malformed; set by `finalize-gen-eval`.
 *  - `lastBlockReason` — set by `generator` on `self-blocked`; drives `markTaskBlocked`.
 *  - `lastVerifyResult` — set by `post-task-check`.
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
  readonly lastVerifyResult?:
    | { readonly kind: 'skipped' }
    | { readonly kind: 'passed' }
    | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
    | undefined;
  /**
   * Outcome of the pre-task-check leaf for the in-flight task — `'success' | 'failed' |
   * 'spawn-error' | 'skipped'`. Read by `post-task-check` to compute attribution. Cleared
   * by `settle-attempt` along with the rest of the per-task verdict state.
   */
  readonly lastPreCheckOutcome?: CheckRunOutcome | undefined;
  readonly lastCommitSha?: string | undefined;
  readonly proposedCommitMessage?: ProposedCommitMessage | undefined;
  readonly expectedBranch?: string | undefined;
}
