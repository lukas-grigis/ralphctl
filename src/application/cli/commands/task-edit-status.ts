/**
 * `task edit-status` — drive task state transitions: mark-in-progress,
 * mark-done, mark-blocked (requires --reason), unblock.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import {
  EditTaskStatusUseCase,
  type EditTaskStatusAction,
  type EditTaskStatusActionKind,
} from '../../../business/usecases/task/edit-task-status.ts';
import { ValidationError } from '../../../domain/values/validation-error.ts';
import { Result } from '../../../domain/result.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

const VALID_ACTIONS: readonly EditTaskStatusActionKind[] = ['mark-in-progress', 'mark-done', 'mark-blocked', 'unblock'];

interface TaskEditStatusFlags {
  readonly sprint: string;
  readonly task: string;
  readonly action: string;
  readonly reason?: string;
}

export function attachTaskEditStatus(group: Command, deps: SharedDeps): void {
  group
    .command('edit-status')
    .description(`change task status (${VALID_ACTIONS.join(' | ')})`)
    .requiredOption('--sprint <id>', 'sprint id')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--action <action>', 'transition to perform')
    .option('--reason <reason>', 'reason for blocking (required with --action mark-blocked)')
    .action(async (opts: TaskEditStatusFlags) => {
      const code = await runTaskEditStatus(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runTaskEditStatus(deps: SharedDeps, opts: TaskEditStatusFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintId = SprintId.parse(opts.sprint);
      if (!sprintId.ok) return Result.error(sprintId.error);
      const taskId = TaskId.parse(opts.task);
      if (!taskId.ok) return Result.error(taskId.error);
      if (!isValidActionKind(opts.action)) {
        return Result.error(
          new ValidationError({
            field: 'action',
            value: opts.action,
            message: `action must be one of: ${VALID_ACTIONS.join(', ')}`,
          })
        );
      }
      const built = buildAction(opts.action, opts.reason);
      if (!built.ok) return Result.error(built.error);
      return new EditTaskStatusUseCase(deps.taskRepo).execute({
        sprintId: sprintId.value,
        taskId: taskId.value,
        action: built.value,
      });
    },
    format: (_d, task) => `${c.green('updated')} task ${c.bold(task.id)} → ${c.bold(task.status)}`,
  });
}

function buildAction(
  kind: EditTaskStatusActionKind,
  reason: string | undefined
): Result<EditTaskStatusAction, ValidationError> {
  switch (kind) {
    case 'mark-in-progress':
      return Result.ok({ kind: 'mark-in-progress' });
    case 'mark-done':
      return Result.ok({ kind: 'mark-done' });
    case 'mark-blocked':
      if (reason === undefined || reason.trim().length === 0) {
        return Result.error(
          new ValidationError({
            field: 'reason',
            value: reason,
            message: '--reason is required when --action is mark-blocked',
          })
        );
      }
      return Result.ok({ kind: 'mark-blocked', reason });
    case 'unblock':
      return Result.ok({ kind: 'unblock' });
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function isValidActionKind(s: string): s is EditTaskStatusActionKind {
  return (VALID_ACTIONS as readonly string[]).includes(s);
}
