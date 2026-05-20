import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { CheckRun } from '@src/domain/entity/attempt.ts';
import { runCheckScriptUseCase } from '@src/business/task/run-check-script.ts';
import { appendAttemptCheckRun, markAttemptBaselineBroken } from '@src/domain/entity/task.ts';
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
 * Pre-task verify gate. Runs the project's `checkScript` BEFORE the AI's generator turn and
 * records the result as a `phase: 'pre'` row on the running attempt. Captures the baseline
 * state of the working tree so the matching post-task-check leaf can attribute correctly:
 *
 *   - pre=green, post=red → AI regressed a green baseline (blame this attempt).
 *   - pre=red,  post=red → pre-existing failure (don't blame the AI, warn instead).
 *   - pre=red,  post=green → AI repaired a pre-existing failure (credit it).
 *
 * Non-blocking by design — a red pre-check never aborts the chain. We still want to give the
 * AI a chance to land work even when the baseline is broken; the post-check decides the task
 * transition. A red pre-check stamps `baselineBroken: true` on the attempt so the TUI surfaces
 * the warning. A spawn-error pre-check is recorded but treated as unknown-state — no
 * `baselineBroken` flag, attribution skipped downstream.
 *
 * Persistence: the leaf calls `taskRepo.update` so the `checkRuns` row survives a chain
 * crash mid-attempt. If persistence fails the chain still continues (logged warn) — the
 * pre-check outcome is the value, not the audit save.
 */

export interface PreTaskCheckLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export interface PreTaskCheckLeafOpts {
  readonly cwd: AbsolutePath;
  readonly checkScript?: string;
  readonly timeoutMs?: number;
}

interface LeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
}

interface LeafOutput {
  readonly task: InProgressTask;
  readonly run: CheckRun;
}

export const preTaskCheckLeaf = (
  deps: PreTaskCheckLeafDeps,
  opts: PreTaskCheckLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, LeafOutput>(`pre-task-check-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<LeafOutput, DomainError>> => {
        const run = await runCheckScriptUseCase({
          cwd: opts.cwd,
          phase: 'pre',
          ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          clock: deps.clock,
          runShellScript: (cwd, script, scriptOpts) => deps.shellScriptRunner.run(cwd, script, scriptOpts),
          logger: deps.logger,
        });

        // Append the row to the running attempt. A red baseline also stamps `baselineBroken`
        // so the TUI can warn the operator. `spawn-error` leaves `baselineBroken` unset —
        // the baseline state is unknown, not known-bad.
        let updated = appendAttemptCheckRun(input.task, run);
        if (!updated.ok) return Result.error(updated.error);
        if (run.outcome === 'failed') {
          const flagged = markAttemptBaselineBroken(updated.value);
          if (!flagged.ok) return Result.error(flagged.error);
          updated = flagged;
        }

        // Persist so the audit row survives a crash. A persistence failure is logged but
        // non-fatal — the chain has already captured the meaningful side effect (the script
        // ran); losing the audit at most causes a re-record on the next resume.
        const persisted = await deps.taskRepo.update(input.sprintId, updated.value);
        if (!persisted.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `pre-task-check audit persist failed for task ${String(taskId)} — ${persisted.error.message}`,
            at: deps.clock(),
          });
        }

        if (run.outcome === 'failed') {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `pre-task-check ${String(opts.cwd)}: baseline already red (exit=${String(run.exitCode)}) — task will start on broken baseline`,
            at: deps.clock(),
          });
        } else if (run.outcome === 'spawn-error') {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `pre-task-check ${String(opts.cwd)}: spawn-error — ${run.stdoutTailBytes}; attribution will be skipped`,
            at: deps.clock(),
          });
        }

        return Result.ok({ task: updated.value, run });
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-pre-task-check',
          attemptedAction: `pre-task-check-${String(taskId)}`,
          message: `pre-task-check-${String(taskId)}: ctx.currentTask is missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `pre-task-check-${String(taskId)}`,
          message: `pre-task-check-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
        });
      }
      return { task: ctx.currentTask, sprintId: ctx.sprintId };
    },
    output: (ctx, out) => ({
      ...ctx,
      currentTask: out.task,
      tasks: (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t)),
      lastPreCheckOutcome: out.run.outcome,
    }),
  });
