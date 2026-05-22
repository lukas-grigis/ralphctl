import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Attribution, VerifyRun, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import { attributeVerify, runVerifyScriptUseCase } from '@src/business/task/run-verify-script.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { appendAttemptVerifyRun, setAttemptAttribution } from '@src/domain/entity/task.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Post-task verify gate — the harness's AUTHORITATIVE independent verification. Runs the
 * project's `verifyScript` after the AI commits its work, regardless of any `task-verified`
 * signal the AI may have emitted. Belt-and-braces: the AI's self-report is advisory; this
 * leaf's outcome is what drives the task transition.
 *
 * Captures a `phase: 'post'` {@link VerifyRun} row on the running attempt and pairs it with
 * the `phase: 'pre'` row from `pre-task-verify` to compute {@link Attribution}:
 *
 *  - pre=success, post=success → `'clean'`           — accept the AI's verdict as-is.
 *  - pre=success, post=failed  → `'regressed'`       — the AI broke a green baseline; block.
 *  - pre=failed,  post=success → `'fixed-baseline'`  — the AI repaired a failure; credit it.
 *  - pre=failed,  post=failed  → `'baseline-broken'` — pre-existing failure; don't blame AI.
 *  - pre=spawn-error           → attribution skipped — unknown baseline state.
 *
 * Ctx side effects mirror the original leaf so `settle-attempt` and `commit-task` continue
 * to read the same fields:
 *
 *   - `lastVerifyResult` — `'skipped' | 'passed' | 'verify-failed'`, derived from the row.
 *   - `lastBlockReason`  — set only on `'regressed'`. Pre-existing failures (`baseline-broken`)
 *                          do NOT block — they preserve the AI's verdict so the operator can
 *                          fix the baseline without losing the AI's work.
 *
 * This leaf must sit BEFORE `commit-task` in the per-task chain — that's how the harness
 * enforces "tests must pass before we declare the task complete." The AI is told to run the
 * verify script itself via the prompt, but the harness is the source of truth.
 */

export interface PostTaskVerifyLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export interface PostTaskVerifyLeafOpts {
  readonly cwd: AbsolutePath;
  readonly verifyScript?: string;
  readonly timeoutMs?: number;
  /**
   * Per-sprint state directory. When set, the leaf writes the full untruncated verify-script
   * output to `<sprintDir>/logs/verify/<task-id>/post-attempt-<N>.log` per audit [01] / [03].
   */
  readonly sprintDir?: AbsolutePath;
}

interface LeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly preOutcome?: VerifyRunOutcome;
}

interface LeafOutput {
  readonly task: InProgressTask;
  readonly run: VerifyRun;
  readonly attribution?: Attribution;
}

/**
 * Derive the legacy `lastVerifyResult` shape (`'skipped' | 'passed' | 'verify-failed'`) from
 * the structured {@link VerifyRun} so `settle-attempt` keeps deriving its existing
 * `verify-failed` {@link AttemptWarning} without rewiring. `spawn-error` is folded into
 * `'verify-failed'` (exitCode = -1) — same legacy behaviour as the prior implementation.
 */
const legacyVerifyResult = (run: VerifyRun): NonNullable<ImplementCtx['lastVerifyResult']> => {
  if (run.outcome === 'skipped') return { kind: 'skipped' };
  if (run.outcome === 'success') return { kind: 'passed' };
  return { kind: 'verify-failed', exitCode: run.exitCode, stderr: run.stdoutTailBytes };
};

export const postTaskVerifyLeaf = (
  deps: PostTaskVerifyLeafDeps,
  opts: PostTaskVerifyLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, LeafOutput>(`post-task-verify-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<LeafOutput, DomainError>> => {
        const { run, rawOutput } = await runVerifyScriptUseCase({
          cwd: opts.cwd,
          phase: 'post',
          ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          clock: deps.clock,
          runShellScript: (cwd, script, scriptOpts) => deps.shellScriptRunner.run(cwd, script, scriptOpts),
          logger: deps.logger,
        });

        // Audit [01] / [03]: persist the full untruncated output to
        // `<sprintDir>/logs/verify/<task-id>/post-attempt-<N>.log`.
        if (opts.sprintDir !== undefined && rawOutput.length > 0) {
          const attemptN = input.task.attempts.length;
          const logPath = join(
            String(opts.sprintDir),
            'logs',
            'verify',
            String(input.task.id),
            `post-attempt-${String(attemptN)}.log`
          );
          const wrote = await writeTextAtomic(logPath, rawOutput);
          if (!wrote.ok) {
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `post-task-verify ${String(opts.cwd)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
              at: deps.clock(),
            });
          }
        }

        let updated = appendAttemptVerifyRun(input.task, run);
        if (!updated.ok) return Result.error(updated.error);

        // Attribution requires both pre and post outcomes. If pre was spawn-error or skipped,
        // `attributeVerify` returns undefined and we leave the field unset.
        const attribution = input.preOutcome !== undefined ? attributeVerify(input.preOutcome, run.outcome) : undefined;
        if (attribution !== undefined) {
          const stamped = setAttemptAttribution(updated.value, attribution);
          if (!stamped.ok) return Result.error(stamped.error);
          updated = stamped;
        }

        const persisted = await deps.taskRepo.update(input.sprintId, updated.value);
        if (!persisted.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `post-task-verify audit persist failed for task ${String(taskId)} — ${persisted.error.message}`,
            at: deps.clock(),
          });
        }

        if (attribution === 'regressed') {
          deps.eventBus.publish({
            type: 'log',
            level: 'error',
            message: `post-task-verify ${String(opts.cwd)}: regressed baseline (exit=${String(run.exitCode)}) — blocking task`,
            at: deps.clock(),
          });
        } else if (attribution === 'baseline-broken') {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `post-task-verify ${String(opts.cwd)}: baseline still red but task started on broken baseline — preserving verdict`,
            at: deps.clock(),
          });
        } else if (attribution === 'fixed-baseline') {
          deps.eventBus.publish({
            type: 'log',
            level: 'info',
            message: `post-task-verify ${String(opts.cwd)}: fixed pre-existing failure (exit=0)`,
            at: deps.clock(),
          });
        } else if (run.outcome === 'spawn-error') {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `post-task-verify ${String(opts.cwd)}: spawn-error — ${run.stdoutTailBytes}; attribution skipped`,
            at: deps.clock(),
          });
        }

        return Result.ok({
          task: updated.value,
          run,
          ...(attribution !== undefined ? { attribution } : {}),
        });
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-post-task-verify',
          attemptedAction: `post-task-verify-${String(taskId)}`,
          message: `post-task-verify-${String(taskId)}: ctx.currentTask is missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `post-task-verify-${String(taskId)}`,
          message: `post-task-verify-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
        });
      }
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        ...(ctx.lastPreVerifyOutcome !== undefined ? { preOutcome: ctx.lastPreVerifyOutcome } : {}),
      };
    },
    output: (ctx, out) => {
      const verifyResult = legacyVerifyResult(out.run);
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t));
      // Default policy: a red post-verify blocks the task — the AI's `task-verified`
      // self-report is overruled by the harness's independent verdict. The ONE escape hatch
      // is `attribution === 'baseline-broken'`: when both pre and post ran red, we have
      // explicit evidence the failure pre-existed the AI's work, so we preserve the AI's
      // verdict (the operator can fix the baseline without losing the AI's work).
      //
      //   - clean           — no block (post is green)
      //   - regressed       — BLOCK with explicit "regressed baseline" reason
      //   - fixed-baseline  — no block (post is green)
      //   - baseline-broken — no block (escape hatch; preserve AI's verdict)
      //   - undefined       — BLOCK on raw red post (no pre-verify evidence to clear it)
      const isRed = out.run.outcome === 'failed' || out.run.outcome === 'spawn-error';
      const shouldBlock = isRed && out.attribution !== 'baseline-broken';
      const blockReason = shouldBlock
        ? out.attribution === 'regressed'
          ? `verify script regressed baseline (exit=${String(out.run.exitCode)}); harness will not commit on red`
          : `verify script failed (exit=${String(out.run.exitCode)}); harness will not commit on red`
        : undefined;
      return {
        ...ctx,
        currentTask: out.task,
        tasks,
        lastVerifyResult: verifyResult,
        ...(blockReason !== undefined ? { lastBlockReason: blockReason } : {}),
      };
    },
  });
