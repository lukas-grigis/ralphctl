/**
 * `sprint requirements [--output <path>]` — write the sprint's refined
 * requirements to a markdown file.
 */
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';
import * as c from 'colorette';

import { ExportRequirementsUseCase } from '@src/business/usecases/sprint/export-requirements.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';

interface RequirementsOptions {
  output?: string;
  sprintId?: string;
}

export function attachSprintRequirements(group: Command, deps: SharedDeps): void {
  group
    .command('requirements [id]')
    .description("export the sprint's refined requirements to a markdown file")
    .option('--output <path>', 'output file path (default: ./<sprintId>-requirements.md)')
    .action(async (id: string | undefined, opts: RequirementsOptions) => {
      const code = await runSprintRequirements(deps, id, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSprintRequirements(
  deps: SharedDeps,
  id: string | undefined,
  opts: RequirementsOptions
): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintR = await resolveSprintId(deps, id);
      if (!sprintR.ok) return sprintR;
      const outPath = resolveOutputPath(opts.output, `${String(sprintR.value)}-requirements.md`);
      const aggregatePath = resolveStoragePaths().requirementsAggregateFile(sprintR.value);
      const uc = new ExportRequirementsUseCase((path, body) => writeFile(path, body, 'utf-8'));
      return uc.execute({ aggregatePath, outputPath: outPath });
    },
    format: (_d, out) => `${c.green('wrote')} ${String(out.path)} (${String(out.byteCount)} bytes)`,
  });
}

function resolveOutputPath(raw: string | undefined, fallbackName: string): AbsolutePath {
  if (raw === undefined || raw.length === 0) {
    return AbsolutePath.trustString(resolve(process.cwd(), fallbackName));
  }
  if (isAbsolute(raw)) return AbsolutePath.trustString(raw);
  return AbsolutePath.trustString(resolve(process.cwd(), raw));
}

export async function resolveSprintId(
  deps: SharedDeps,
  id: string | undefined
): Promise<Result<SprintId, ValidationError>> {
  if (id !== undefined && id.length > 0) {
    const parsed = SprintId.parse(id);
    if (!parsed.ok) {
      return Result.error(
        new ValidationError({
          field: 'sprint.id',
          value: id,
          message: parsed.error.message,
        })
      );
    }
    return Result.ok(parsed.value);
  }
  const loaded = await deps.configStore.load();
  if (!loaded.ok) {
    return Result.error(
      new ValidationError({
        field: 'config.currentSprint',
        value: null,
        message: loaded.error.message,
      })
    );
  }
  if (loaded.value.currentSprint === null) {
    return Result.error(
      new ValidationError({
        field: 'sprint.id',
        value: id,
        message: 'no current sprint set — pass <id> or run `ralphctl sprint set-current`',
      })
    );
  }
  return Result.ok(loaded.value.currentSprint);
}
