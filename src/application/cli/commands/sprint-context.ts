/**
 * `sprint context [--output <path>]` — write the harness context (sprint
 * + tickets + tasks + check scripts + project info) to a markdown file.
 */
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';
import * as c from 'colorette';

import { ExportContextUseCase } from '../../../business/usecases/sprint/export-context.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { resolveSprintId } from './sprint-requirements.ts';

interface ContextOptions {
  output?: string;
}

export function attachSprintContext(group: Command, deps: SharedDeps): void {
  group
    .command('context [id]')
    .description('export the full harness context for a sprint to a markdown file')
    .option('--output <path>', 'output file path (default: ./<sprintId>-context.md)')
    .action(async (id: string | undefined, opts: ContextOptions) => {
      const code = await runSprintContext(deps, id, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runSprintContext(
  deps: SharedDeps,
  id: string | undefined,
  opts: ContextOptions
): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const sprintR = await resolveSprintId(deps, id);
      if (!sprintR.ok) return Result.error(sprintR.error);
      const outPath = resolveOutputPath(opts.output, `${String(sprintR.value)}-context.md`);
      const uc = new ExportContextUseCase(deps.sprintRepo, deps.taskRepo, deps.projectRepo, (path, body) =>
        writeFile(path, body, 'utf-8')
      );
      return uc.execute({ sprintId: sprintR.value, outputPath: outPath });
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
