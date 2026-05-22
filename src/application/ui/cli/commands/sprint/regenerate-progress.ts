import { join } from 'node:path';
import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { writeProgressSnapshot } from '@src/business/sprint/write-progress-snapshot.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

/**
 * Register `ralphctl sprint regenerate-progress <id>` on the supplied sprint command group.
 *
 * Operator-facing escape hatch: re-renders `<sprintDir>/progress.md` from the current
 * persisted state (`sprint.json` / `execution.json` / `tasks.json` + `chain.log` +
 * `decisions.log`). Useful after manually pruning a corrupted log entry — the snapshot
 * regenerates byte-deterministically from whatever is on disk right now.
 *
 * The command dispatches directly to {@link writeProgressSnapshot}: that helper IS the
 * canonical regeneration entry point used by the implement chain at its three trigger
 * moments (sprint start, settle-attempt, status transition), so calling it here keeps the
 * one-shot CLI behaviour byte-identical to what the live chain produces.
 *
 * Exit status: 0 on success, 1 on any error (with the message on stderr). Mirrors the
 * other sprint subcommands in `sprint.ts`.
 *
 * @public
 */
export const registerRegenerateProgressCommand = (sprintCmd: Command): void => {
  sprintCmd
    .command('regenerate-progress <id>')
    .description('re-render <sprintDir>/progress.md from current persisted state + chain.log + decisions.log')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps, storage } = await bootstrapCli();

      const sprintResult = await deps.sprintRepo.findById(id.value);
      if (!sprintResult.ok) {
        process.stderr.write(`error: ${sprintResult.error.message}\n`);
        process.exit(1);
        return;
      }
      const sprint = sprintResult.value;

      const executionResult = await deps.sprintExecutionRepo.findById(id.value);
      if (!executionResult.ok) {
        process.stderr.write(`error: ${executionResult.error.message}\n`);
        process.exit(1);
        return;
      }
      const execution = executionResult.value;

      const tasksResult = await deps.taskRepo.findBySprintId(id.value);
      if (!tasksResult.ok) {
        process.stderr.write(`error: ${tasksResult.error.message}\n`);
        process.exit(1);
        return;
      }

      const sprintDir = join(String(storage.dataRoot), 'sprints', String(sprint.id));
      const progressPath = AbsolutePath.parse(join(sprintDir, 'progress.md'));
      if (!progressPath.ok) {
        process.stderr.write(`error: ${progressPath.error.message}\n`);
        process.exit(1);
        return;
      }
      const chainLogPath = AbsolutePath.parse(join(sprintDir, 'chain.log'));
      if (!chainLogPath.ok) {
        process.stderr.write(`error: ${chainLogPath.error.message}\n`);
        process.exit(1);
        return;
      }
      const decisionsLogPath = AbsolutePath.parse(join(sprintDir, 'decisions.log'));
      if (!decisionsLogPath.ok) {
        process.stderr.write(`error: ${decisionsLogPath.error.message}\n`);
        process.exit(1);
        return;
      }

      const result = await writeProgressSnapshot(
        {
          loadChainLog: deps.loadChainLog,
          loadDecisionsLog: deps.loadDecisionsLog,
          writeFile: deps.writeFile,
          clock: deps.clock,
          logger: deps.logger,
        },
        {
          sprint,
          execution,
          tasks: tasksResult.value,
          chainLogPath: chainLogPath.value,
          decisionsLogPath: decisionsLogPath.value,
          progressFile: progressPath.value,
        }
      );

      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`progress.md regenerated at ${String(progressPath.value)}\n`);
    });
};
