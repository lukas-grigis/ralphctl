import { join } from 'node:path';
import {
  type SettleAttemptOutput,
  type SettleAttemptProps,
  settleAttemptUseCase,
} from '@src/business/task/settle-attempt.ts';
import type { Attempt, AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { CriterionVerdict, EvaluationSignal } from '@src/domain/signal.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import { boundVerifyExcerpt } from '@src/business/task/bound-verify-excerpt.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { gitHasUncommittedChanges } from '@src/integration/io/git-operations.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { renderRoundOutcome, type RoundVerdict } from '@src/business/task/render-round-outcome.ts';

export interface SettleAttemptLeafDeps {
  readonly taskRepo: SettleAttemptProps['taskRepo'];
  readonly clock: SettleAttemptProps['clock'];
  readonly logger: SettleAttemptProps['logger'];
  /**
   * Used for the worktree-clean guardrail in `settleAttemptUseCase`. Optional so legacy /
   * test callers without a real git runner can still settle (the guardrail is then skipped).
   * Production wires the real GitRunner so dirty-tree settles are refused.
   */
  readonly gitRunner?: GitRunner;
}

export interface SettleAttemptLeafOpts {
  /** Worktree the commit-task leaf ran against — used for the dirty-tree guardrail. */
  readonly cwd: AbsolutePath;
}

interface SettleInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly verdict: RunTaskVerdict;
  readonly blockedReason?: string;
  readonly warning?: AttemptWarning;
  readonly workspaceRoot?: AbsolutePath;
  readonly roundNum?: number;
  readonly evaluation?: EvaluationSignal;
  /**
   * Structured per-criterion verdicts from this round's evaluation — folded onto the task's durable
   * `criteriaVerdicts` by `settleAttemptUseCase`. Projected from `ctx.lastEvaluation.criteria`;
   * harness-authored, never from agent prose.
   */
  readonly criteria?: readonly CriterionVerdict[];
  readonly shouldFailAttempt?: boolean;
  /**
   * Generator / evaluator session ids for the just-settled round, projected from
   * `ctx.priorGeneratorSessionId` / `ctx.priorEvaluatorSessionId` (the gen-eval leaves stamp them
   * each round; the NEXT attempt's start-attempt clears them, so both are live at settle time).
   * Rendered into `outcome.md` so a post-mortem reader can `--resume <session>` the exact thread.
   */
  readonly generatorSessionId?: string;
  readonly evaluatorSessionId?: string;
}

/**
 * Chain leaf — projects ctx into a SettleInput and delegates to settleAttemptUseCase. Business
 * policy (decision tree for verdict + blockedReason + warning → final task status) lives in
 * `@src/business/task/settle-attempt.ts`.
 *
 * After the use case settles the attempt, the leaf writes a self-describing
 * `outcome.md` under `<workspaceRoot>/rounds/<n>/outcome.md` so a fresh agent (or human
 * post-mortem reader) can open ONE file per round and reconstruct what happened — verdict,
 * dimension scores, critique, session ids, commit. The write is best-effort: a failure is
 * logged and swallowed because the audit artefact must never take down the chain.
 */
export const settleAttemptLeaf = (
  deps: SettleAttemptLeafDeps,
  opts: SettleAttemptLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const { gitRunner } = deps;
  const hasUncommittedChanges: SettleAttemptProps['hasUncommittedChanges'] | undefined =
    gitRunner !== undefined ? () => gitHasUncommittedChanges(gitRunner, opts.cwd) : undefined;
  return leaf<ImplementCtx, SettleInput, SettleAttemptOutput>(`settle-attempt-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const settled = await settleAttemptUseCase({
          ...deps,
          ...input,
          cwd: opts.cwd,
          ...(hasUncommittedChanges !== undefined ? { hasUncommittedChanges } : {}),
        });
        if (!settled.ok) return settled;
        // Write the per-round outcome.md from the final round of the just-settled attempt.
        // The settle leaf is the only chain point where we have BOTH the latest evaluator
        // signal (still on ctx) AND the post-settle attempt state (with finishedAt and the
        // final verdict). Anywhere earlier would be missing one of those.
        if (input.workspaceRoot !== undefined && input.roundNum !== undefined) {
          await writeRoundOutcome({
            workspaceRoot: input.workspaceRoot,
            roundNum: input.roundNum,
            task: settled.value,
            verdict: deriveRoundVerdict(input.verdict, input.warning),
            ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
            ...(input.generatorSessionId !== undefined ? { generatorSessionId: input.generatorSessionId } : {}),
            ...(input.evaluatorSessionId !== undefined ? { evaluatorSessionId: input.evaluatorSessionId } : {}),
            logger: deps.logger,
          });
        }
        return settled;
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-settle',
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: ctx.currentTask is missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
        });
      }
      if (ctx.lastVerdict === undefined && ctx.lastBlockReason === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-settle',
          attemptedAction: `settle-attempt-${String(taskId)}`,
          message: `settle-attempt-${String(taskId)}: no verdict or block reason on ctx — at least one turn must run`,
        });
      }
      const warning: AttemptWarning | undefined =
        ctx.lastVerifyResult !== undefined && ctx.lastVerifyResult.kind === 'verify-failed'
          ? {
              kind: 'verify-failed',
              exitCode: ctx.lastVerifyResult.exitCode,
              // Bound the excerpt persisted onto the attempt: the warning lives on the task in
              // ctx.tasks + tasks.json for the whole sprint, so storing the full (≤50 MB) verify
              // body here re-creates the Verification.output OOM (see bound-verify-excerpt.ts).
              // The untruncated body is on disk at <sprintDir>/logs/verify/<task-id>/...
              stderr: boundVerifyExcerpt(ctx.lastVerifyResult.stderr),
            }
          : ctx.lastWarning;
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        verdict: ctx.lastVerdict ?? 'failed',
        ...(ctx.lastBlockReason !== undefined ? { blockedReason: ctx.lastBlockReason } : {}),
        ...(warning !== undefined ? { warning } : {}),
        ...(ctx.taskWorkspaceRoot !== undefined ? { workspaceRoot: ctx.taskWorkspaceRoot } : {}),
        ...(ctx.currentRoundNum !== undefined ? { roundNum: ctx.currentRoundNum } : {}),
        ...(ctx.lastEvaluation !== undefined ? { evaluation: ctx.lastEvaluation } : {}),
        ...(ctx.lastEvaluation?.criteria !== undefined ? { criteria: ctx.lastEvaluation.criteria } : {}),
        ...(ctx.lastShouldFailAttempt === true ? { shouldFailAttempt: true } : {}),
        ...(ctx.priorGeneratorSessionId !== undefined
          ? { generatorSessionId: String(ctx.priorGeneratorSessionId) }
          : {}),
        ...(ctx.priorEvaluatorSessionId !== undefined
          ? { evaluatorSessionId: String(ctx.priorEvaluatorSessionId) }
          : {}),
      };
    },
    output: (ctx, settled) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === settled.id ? (settled as Task) : t));
      return {
        ...ctx,
        tasks,
        currentTask: undefined,
        currentTaskId: undefined,
        lastVerdict: undefined,
        lastBlockReason: undefined,
        lastExit: undefined,
        lastWarning: undefined,
        lastVerifyResult: undefined,
        lastPreVerifyOutcome: undefined,
        lastCommitSha: undefined,
        lastShouldFailAttempt: undefined,
      };
    },
  });
};

/**
 * Map the harness's gen-eval verdict + optional warning into the {@link RoundVerdict} the
 * outcome.md renderer reads. The renderer's `plateau` branch is reserved for the specific
 * "two consecutive failed evals with identical failed-dimension sets" terminator that
 * `finalize-gen-eval` stamps as an `AttemptWarning` of kind `'plateau'`.
 */
const deriveRoundVerdict = (verdict: RunTaskVerdict, warning: AttemptWarning | undefined): RoundVerdict => {
  if (warning?.kind === 'plateau') return 'plateau';
  if (verdict === 'passed') return 'passed';
  return 'failed';
};

/**
 * Render and write `<workspaceRoot>/rounds/<n>/outcome.md`. Best-effort: a failure to write
 * the audit artefact is logged and swallowed — the chain must not halt on a derived file.
 *
 * Prefers the per-round generator session id projected from `ctx.priorGeneratorSessionId` over the
 * attempt-level `attempt.sessionId` fallback (the latter is the FIRST round's id; the ctx field is
 * the LATEST round's, which matches THIS outcome.md). The evaluator session id has no attempt-level
 * fallback — it comes solely from `ctx.priorEvaluatorSessionId`. Either missing → renderer shows `—`.
 */
const writeRoundOutcome = async (params: {
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
  readonly task: SettleAttemptOutput;
  readonly verdict: RoundVerdict;
  readonly evaluation?: EvaluationSignal;
  readonly generatorSessionId?: string;
  readonly evaluatorSessionId?: string;
  readonly logger: SettleAttemptProps['logger'];
}): Promise<void> => {
  const attempt = latestAttempt(params.task);
  if (attempt === undefined) {
    params.logger
      .named('settle-attempt.outcome')
      .warn('no attempt recorded on task; skipping outcome.md', { taskId: String(params.task.id) });
    return;
  }
  // Prefer the per-round ctx generator id; fall back to the attempt-level id stamped by start-attempt.
  const generatorSessionId = params.generatorSessionId ?? attempt.sessionId;
  const content = renderRoundOutcome({
    roundN: params.roundNum,
    attemptN: attempt.n,
    attempt,
    verdict: params.verdict,
    ...(params.evaluation !== undefined ? { evaluation: params.evaluation } : {}),
    ...(generatorSessionId !== undefined ? { generatorSessionId } : {}),
    ...(params.evaluatorSessionId !== undefined ? { evaluatorSessionId: params.evaluatorSessionId } : {}),
    ...(attemptDurationMs(attempt) !== undefined ? { durationMs: attemptDurationMs(attempt)! } : {}),
  });
  const path = join(String(params.workspaceRoot), 'rounds', String(params.roundNum), 'outcome.md');
  const wrote = await writeTextAtomic(path, content);
  if (!wrote.ok) {
    params.logger.named('settle-attempt.outcome').warn('outcome.md write failed', {
      path,
      error: wrote.error.message,
    });
  }
};

const latestAttempt = (task: { readonly attempts: readonly Attempt[] }): Attempt | undefined =>
  task.attempts[task.attempts.length - 1];

const attemptDurationMs = (attempt: Attempt): number | undefined => {
  if (attempt.status === 'running') return undefined;
  return new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime();
};
