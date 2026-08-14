import { join } from 'node:path';
import {
  type SettleAttemptOutput,
  type SettleAttemptProps,
  settleAttemptUseCase,
} from '@src/business/task/settle-attempt.ts';
import type { Attempt, AttemptUsage, AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
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
import type { WriteFile } from '@src/business/io/write-file.ts';
import { renderRoundOutcome, type RoundVerdict } from '@src/business/task/render-round-outcome.ts';
import { resetSettleScratch } from '@src/application/flows/implement/sprint-scoped-projection.ts';

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
  /**
   * Atomic whole-file writer for the per-round `outcome.md` audit artefact — see
   * `writeRoundOutcome`. Optional: callers that don't wire the port (legacy / test call sites
   * outside this leaf's own ownership) fall back to the direct `writeTextAtomic` adapter via
   * {@link defaultWriteFile}, so behaviour is unchanged either way.
   */
  readonly writeFile?: WriteFile;
}

export interface SettleAttemptLeafOpts {
  /** Worktree the commit-task leaf ran against — used for the dirty-tree guardrail. */
  readonly cwd: AbsolutePath;
}

/** Shared `logger.named(...)` scope for every outcome.md diagnostic below. */
const OUTCOME_LOGGER_NAME = 'settle-attempt.outcome';

/** Fallback `WriteFile` for callers that don't (yet) wire the port — same atomic adapter either way. */
const defaultWriteFile: WriteFile = (path, content) => writeTextAtomic(String(path), content);

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
  /**
   * Per-attempt cost totals projected from the `ctx.currentAttempt{InputTokens,OutputTokens,
   * DurationMs}` accumulators the gen-eval leaves folded across this attempt's spawns. Absent when
   * no spawn reported anything (a zero-turn self-block, or providers that report no usage).
   */
  readonly usage?: AttemptUsage;
}

/**
 * Project the per-attempt cost accumulators off ctx into the ready-to-spread `{ usage }` fragment
 * — `{}` when the attempt recorded nothing at all. Absent counters stay absent: the harness
 * persists what a provider reported, never a substituted `0`.
 */
const projectAttemptUsage = (ctx: ImplementCtx): Pick<SettleInput, 'usage'> => {
  const usage: AttemptUsage = {
    ...(ctx.currentAttemptInputTokens !== undefined ? { inputTokens: ctx.currentAttemptInputTokens } : {}),
    ...(ctx.currentAttemptOutputTokens !== undefined ? { outputTokens: ctx.currentAttemptOutputTokens } : {}),
    ...(ctx.currentAttemptDurationMs !== undefined ? { durationMs: ctx.currentAttemptDurationMs } : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : {};
};

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
/**
 * Builds the `hasUncommittedChanges` probe `settleAttemptUseCase` uses for the worktree-clean
 * guardrail. Split out so the leaf's construction body reads as one line per collaborator.
 */
const checkWorktreeClean =
  (gitRunner: GitRunner, cwd: AbsolutePath): SettleAttemptProps['hasUncommittedChanges'] =>
  () =>
    gitHasUncommittedChanges(gitRunner, cwd);

/**
 * Best-effort write of the per-round `outcome.md` for the just-settled attempt. Only fires when
 * BOTH `workspaceRoot` and `roundNum` are known on the input (absent on a zero-turn self-block, where
 * there is no round to describe). Split out of `execute` so that closure's own line count stays
 * under the project's per-function ceiling.
 */
const maybeWriteRoundOutcome = async (
  deps: SettleAttemptLeafDeps,
  input: SettleInput,
  settled: SettleAttemptOutput
): Promise<void> => {
  if (input.workspaceRoot === undefined || input.roundNum === undefined) return;
  // The settle leaf is the only chain point where we have BOTH the latest evaluator signal (still
  // on ctx) AND the post-settle attempt state (with finishedAt and the final verdict). Anywhere
  // earlier would be missing one of those.
  await writeRoundOutcome({
    workspaceRoot: input.workspaceRoot,
    roundNum: input.roundNum,
    task: settled,
    verdict: deriveRoundVerdict(input.verdict, input.warning),
    // `shouldFailAttempt === true` is set (in finalize-gen-eval) exactly when a fresh attempt is
    // granted, so it reliably means "another round follows"; a self-blocked or budget-exhausted
    // terminal round leaves it unset.
    willRetryNextRound: input.shouldFailAttempt === true,
    ...(input.evaluation !== undefined ? { evaluation: input.evaluation } : {}),
    ...(input.generatorSessionId !== undefined ? { generatorSessionId: input.generatorSessionId } : {}),
    ...(input.evaluatorSessionId !== undefined ? { evaluatorSessionId: input.evaluatorSessionId } : {}),
    logger: deps.logger,
    writeFile: deps.writeFile ?? defaultWriteFile,
  });
};

/**
 * Derive this round's {@link AttemptWarning} from ctx: a `verify-failed` `lastVerifyResult`
 * overrides any generic `lastWarning` (the harness's own gate outranks a signal-derived warning),
 * bounding the persisted excerpt so the attempt's warning never re-creates the
 * `Verification.output` OOM (see `bound-verify-excerpt.ts`) — the untruncated body lives on disk at
 * `<sprintDir>/logs/verify/<task-id>/...`. Falls back to `ctx.lastWarning` otherwise.
 */
const deriveSettleWarning = (ctx: ImplementCtx): AttemptWarning | undefined =>
  ctx.lastVerifyResult !== undefined && ctx.lastVerifyResult.kind === 'verify-failed'
    ? {
        kind: 'verify-failed',
        exitCode: ctx.lastVerifyResult.exitCode,
        stderr: boundVerifyExcerpt(ctx.lastVerifyResult.stderr),
      }
    : ctx.lastWarning;

/**
 * Project every OPTIONAL {@link SettleInput} field straight off ctx (present only when the source
 * field is set). Split out of `input()` so that projection's own guard-clause + verdict/warning
 * derivation stays under the project's complexity ceiling — this helper is a flat list of
 * independent conditional spreads, not branching logic.
 */
const projectOptionalSettleFields = (
  ctx: ImplementCtx,
  warning: AttemptWarning | undefined
): Pick<
  SettleInput,
  | 'blockedReason'
  | 'warning'
  | 'workspaceRoot'
  | 'roundNum'
  | 'evaluation'
  | 'criteria'
  | 'shouldFailAttempt'
  | 'generatorSessionId'
  | 'evaluatorSessionId'
  | 'usage'
> => ({
  ...(ctx.lastBlockReason !== undefined ? { blockedReason: ctx.lastBlockReason } : {}),
  ...(warning !== undefined ? { warning } : {}),
  ...(ctx.taskWorkspaceRoot !== undefined ? { workspaceRoot: ctx.taskWorkspaceRoot } : {}),
  ...(ctx.currentRoundNum !== undefined ? { roundNum: ctx.currentRoundNum } : {}),
  ...(ctx.lastEvaluation !== undefined ? { evaluation: ctx.lastEvaluation } : {}),
  ...(ctx.lastEvaluation?.criteria !== undefined ? { criteria: ctx.lastEvaluation.criteria } : {}),
  ...(ctx.lastShouldFailAttempt === true ? { shouldFailAttempt: true } : {}),
  ...(ctx.priorGeneratorSessionId !== undefined ? { generatorSessionId: String(ctx.priorGeneratorSessionId) } : {}),
  ...(ctx.priorEvaluatorSessionId !== undefined ? { evaluatorSessionId: String(ctx.priorEvaluatorSessionId) } : {}),
  ...projectAttemptUsage(ctx),
});

export const settleAttemptLeaf = (
  deps: SettleAttemptLeafDeps,
  opts: SettleAttemptLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const { gitRunner } = deps;
  const hasUncommittedChanges: SettleAttemptProps['hasUncommittedChanges'] | undefined =
    gitRunner !== undefined ? checkWorktreeClean(gitRunner, opts.cwd) : undefined;
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
        await maybeWriteRoundOutcome(deps, input, settled.value);
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
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        verdict: ctx.lastVerdict ?? 'failed',
        ...projectOptionalSettleFields(ctx, deriveSettleWarning(ctx)),
      };
    },
    // Cleared via the type-derived per-settle reset (see `sprint-scoped-projection.ts`) —
    // deliberately distinct from `start-attempt`'s reset: `progress-journal` runs right after this
    // leaf and still needs `ctx.currentRoundNum` / `ctx.lastEvaluation` / the rest of that bucket.
    output: (ctx, settled) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === settled.id ? (settled as Task) : t));
      return {
        ...ctx,
        ...resetSettleScratch(),
        tasks,
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
  readonly willRetryNextRound: boolean;
  readonly evaluation?: EvaluationSignal;
  readonly generatorSessionId?: string;
  readonly evaluatorSessionId?: string;
  readonly logger: SettleAttemptProps['logger'];
  readonly writeFile: WriteFile;
}): Promise<void> => {
  const attempt = latestAttempt(params.task);
  if (attempt === undefined) {
    params.logger
      .named(OUTCOME_LOGGER_NAME)
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
    willRetryNextRound: params.willRetryNextRound,
    ...(params.evaluation !== undefined ? { evaluation: params.evaluation } : {}),
    ...(generatorSessionId !== undefined ? { generatorSessionId } : {}),
    ...(params.evaluatorSessionId !== undefined ? { evaluatorSessionId: params.evaluatorSessionId } : {}),
    ...(attemptDurationMs(attempt) !== undefined ? { durationMs: attemptDurationMs(attempt)! } : {}),
  });
  const path = join(String(params.workspaceRoot), 'rounds', String(params.roundNum), 'outcome.md');
  const parsedPath = AbsolutePath.parse(path);
  if (!parsedPath.ok) {
    params.logger.named(OUTCOME_LOGGER_NAME).warn('outcome.md write failed — could not resolve path', {
      path,
      error: parsedPath.error.message,
    });
    return;
  }
  const wrote = await params.writeFile(parsedPath.value, content);
  if (!wrote.ok) {
    params.logger.named(OUTCOME_LOGGER_NAME).warn('outcome.md write failed', {
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
