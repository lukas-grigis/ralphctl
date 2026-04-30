/**
 * `sprint set-current` — point the `currentSprint` config at the given id.
 *
 * Verifies the target sprint exists before writing config so a stale id
 * cannot land in the file. Pass `--clear` to wipe the pointer.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import { SetCurrentSprintUseCase } from '../../config/set-current-sprint.ts';
import { Result } from '../../../domain/result.ts';
import { ValidationError } from '../../../domain/values/validation-error.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { parseId, runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface SprintSetCurrentFlags {
  readonly id?: string;
  readonly clear?: boolean;
}

export function attachSprintSetCurrent(group: Command, deps: SharedDeps): void {
  group
    .command('set-current')
    .description('point currentSprint config at the given id (or clear it)')
    .option('--id <id>', 'sprint id to set as current')
    .option('--clear', 'clear the current-sprint pointer')
    .action(async (opts: SprintSetCurrentFlags) => {
      const code = await runSprintSetCurrent(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintSetCurrent(deps: SharedDeps, opts: SprintSetCurrentFlags): Promise<ExitCode> {
  return runCommand<{ readonly cleared: boolean }>({
    deps,
    body: async () => {
      if (opts.clear !== true && (opts.id === undefined || opts.id.trim() === '')) {
        return Result.error(
          new ValidationError({
            field: 'id',
            value: opts.id,
            message: 'either --id <id> or --clear is required',
          })
        );
      }

      const useCase = new SetCurrentSprintUseCase(deps.sprintRepo, deps.configStore);
      if (opts.clear === true) {
        const r = await useCase.execute({ id: null });
        if (!r.ok) return Result.error(r.error);
        return Result.ok({ cleared: true });
      }

      // opts.id is defined here.
      const id = parseId(SprintId, opts.id ?? '');
      if (!id.ok) return id;
      const r = await useCase.execute({ id: id.value });
      if (!r.ok) return Result.error(r.error);
      return Result.ok({ cleared: false });
    },
    format: (_d, value) =>
      value.cleared
        ? `${c.green('cleared')} current sprint`
        : `${c.green('set current sprint')} ${c.bold(opts.id ?? '')}`,
  });
}
