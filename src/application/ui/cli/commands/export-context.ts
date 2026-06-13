import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { createExportContextFlow } from '@src/application/flows/export-context/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';

interface Opts {
  readonly sprint?: string;
  readonly project?: string;
  readonly output: string;
}

/**
 * Register the `export-context` CLI command.
 *
 *   ralphctl export-context [--sprint <id>] [--project <id>] --output <path>
 *
 * Renders the harness-context markdown (sprint + project + tasks) to the
 * supplied path. `--sprint` defaults to the pinned current sprint;
 * `--project` defaults to the sprint's own project and, when supplied, is
 * validated and cross-checked against the sprint by the flow. Exits 0 with a
 * one-line confirmation, or 1 with a stderr message on validation / NotFound /
 * IO error.
 */
export const registerExportContextCommand = (program: Command): void => {
  program
    .command('export-context')
    .description('render the harness-context markdown for a sprint')
    .option('-s, --sprint <id>', 'sprint id (defaults to the current sprint)')
    .option('-p, --project <id>', "project id (defaults to the sprint's project)")
    .requiredOption('-o, --output <path>', 'output markdown path')
    .action(async (opts: Opts) => {
      const outputPath = AbsolutePath.parse(opts.output);
      if (!outputPath.ok) {
        process.stderr.write(`error: --output: ${outputPath.error.message}\n`);
        process.exit(1);
        return;
      }

      // Validate the override with the same UUIDv7 parser the sibling commands use. The flow then
      // cross-checks the parsed id against the sprint's own project (and defaults to it if omitted).
      let projectId: ProjectId | undefined;
      if (opts.project !== undefined) {
        const parsed = ProjectId.parse(opts.project);
        if (!parsed.ok) {
          process.stderr.write(`error: invalid project id: ${parsed.error.message}\n`);
          process.exit(1);
          return;
        }
        projectId = parsed.value;
      }

      const { deps, storage } = await bootstrapCli();
      const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
      if (!sprintId.ok) {
        process.stderr.write(`error: ${sprintId.error.message}\n`);
        process.exit(1);
        return;
      }
      if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
      const flow = createExportContextFlow({
        sprintRepo: deps.sprintRepo,
        projectRepo: deps.projectRepo,
        taskRepo: deps.taskRepo,
        writeFile: deps.writeFile,
      });
      const result = await flow.execute({
        input: {
          sprintId: sprintId.value.sprintId,
          ...(projectId !== undefined ? { projectId } : {}),
          outputPath: outputPath.value,
        },
      });

      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      const out = result.value.ctx.output!;
      process.stdout.write(`wrote ${String(out.outputPath)} (${String(out.byteCount)} bytes)\n`);
    });
};
