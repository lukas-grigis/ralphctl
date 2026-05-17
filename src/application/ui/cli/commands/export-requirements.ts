import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

interface Opts {
  readonly sprint: string;
  readonly output: string;
}

/**
 * Register the `export-requirements` CLI command.
 *
 *   ralphctl export-requirements --sprint <id> --output <path>
 *
 * Writes the sprint's approved-ticket requirements to the supplied
 * markdown path. Exits 0 with a one-line confirmation, or 1 with a
 * stderr message on validation / NotFound / IO error.
 */
export const registerExportRequirementsCommand = (program: Command): void => {
  program
    .command('export-requirements')
    .description("write the sprint's approved-ticket requirements to a markdown file")
    .requiredOption('-s, --sprint <id>', 'sprint id')
    .requiredOption('-o, --output <path>', 'output markdown path')
    .action(async (opts: Opts) => {
      const outputPath = AbsolutePath.parse(opts.output);
      if (!outputPath.ok) {
        process.stderr.write(`error: --output: ${outputPath.error.message}\n`);
        process.exit(1);
        return;
      }

      const { deps } = await bootstrapCli();
      const flow = createExportRequirementsFlow({
        sprintRepo: deps.sprintRepo,
        writeFile: deps.writeFile,
      });
      const result = await flow.execute({
        input: { sprintId: opts.sprint as SprintId, outputPath: outputPath.value },
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
