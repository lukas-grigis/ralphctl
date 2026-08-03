import type { Command } from 'commander';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createExportRequirementsFlow } from '@src/application/flows/export-requirements/flow.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { pinFallbackNotice, resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';

interface Opts {
  readonly sprint?: string;
  readonly output: string;
}

const exportRequirementsAction = async (opts: Opts): Promise<void> => {
  const outputPath = AbsolutePath.parse(opts.output);
  if (!outputPath.ok) {
    fail(`--output: ${outputPath.error.message}`);
    return;
  }

  const { deps, storage } = await bootstrapCli();
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (!sprintId.ok) {
    fail(sprintId.error.message);
    return;
  }
  if (sprintId.value.fromPin) process.stderr.write(pinFallbackNotice(sprintId.value.sprintId));
  const flow = createExportRequirementsFlow({
    sprintRepo: deps.sprintRepo,
    writeFile: deps.writeFile,
  });
  const result = await flow.execute({
    input: { sprintId: sprintId.value.sprintId, outputPath: outputPath.value },
  });

  if (!result.ok) {
    fail(result.error.error.message);
    return;
  }
  const out = result.value.ctx.output!;
  process.stdout.write(`wrote ${String(out.outputPath)} (${String(out.byteCount)} bytes)\n`);
};

/**
 * Register the `export-requirements` CLI command.
 *
 *   ralphctl export-requirements [--sprint <id>] --output <path>
 *
 * Writes the sprint's approved-ticket requirements to the supplied
 * markdown path. `--sprint` defaults to the pinned current sprint.
 * Exits 0 with a one-line confirmation, or 1 with a stderr message on
 * validation / NotFound / IO error.
 */
export const registerExportRequirementsCommand = (program: Command): void => {
  program
    .command('export-requirements')
    .description("write the sprint's approved-ticket requirements to a markdown file")
    .option('-s, --sprint <id>', 'sprint id (defaults to the current sprint)')
    .requiredOption('-o, --output <path>', 'output markdown path')
    .action(exportRequirementsAction);
};
