import { Command } from 'commander';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { parseImplementRoleOverrides } from '@src/application/ui/cli/parse-implement-role-overrides.ts';
import { registerExportRequirementsCommand } from '@src/application/ui/cli/commands/export-requirements.ts';
import { registerExportContextCommand } from '@src/application/ui/cli/commands/export-context.ts';
import { registerCreatePrCommand } from '@src/application/ui/cli/commands/create-pr.ts';
import { registerDoctorCommand } from '@src/application/ui/cli/commands/doctor.ts';
import { registerSettingsCommand } from '@src/application/ui/cli/commands/settings.ts';
import { registerCompletionCommand } from '@src/application/ui/cli/commands/completion.ts';
import { registerProjectCommand } from '@src/application/ui/cli/commands/project.ts';
import { registerSprintCommand } from '@src/application/ui/cli/commands/sprint.ts';
import { registerTicketCommand } from '@src/application/ui/cli/commands/ticket.ts';
import { registerTaskCommand } from '@src/application/ui/cli/commands/task.ts';
import { registerRunsCommand } from '@src/application/ui/cli/commands/runs.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

/**
 * Build and run the CLI. The default action (no subcommand) launches the
 * interactive TUI; named subcommands run a single flow against the wired
 * bootstrap (see `bootstrap.ts`).
 *
 * Long-running chain flows (implement / refine / plan / review / etc.) are
 * not CLI-accessible — their parameters require interactive context that
 * lives in the TUI runtime. See `docs/api.md` for the full surface.
 */
export const runCli = async (argv: readonly string[]): Promise<void> => {
  const program = new Command();

  program
    .name('ralphctl')
    .description('ralphctl — interactive TUI and CLI')
    .version(CLI_METADATA.currentVersion, '-v, --version', 'show version')
    // Per-launch implement-role overrides. Each role is a {provider, model} pair — both
    // flags must be supplied together for a role; supplying only one half errors out below.
    // Operators reach for these to A/B a single implement run against a different provider
    // without rewriting `settings.ai.implement`.
    .option(
      '--implement-generator-provider <provider>',
      'override settings.ai.implement.generator.provider for this launch (requires --implement-generator-model)'
    )
    .option(
      '--implement-generator-model <model>',
      'override settings.ai.implement.generator.model for this launch (requires --implement-generator-provider)'
    )
    .option(
      '--implement-evaluator-provider <provider>',
      'override settings.ai.implement.evaluator.provider for this launch (requires --implement-evaluator-model)'
    )
    .option(
      '--implement-evaluator-model <model>',
      'override settings.ai.implement.evaluator.model for this launch (requires --implement-evaluator-provider)'
    )
    .action(async (opts: Record<string, unknown>) => {
      const parsed = parseImplementRoleOverrides({
        ...(typeof opts.implementGeneratorProvider === 'string'
          ? { generatorProvider: opts.implementGeneratorProvider }
          : {}),
        ...(typeof opts.implementGeneratorModel === 'string' ? { generatorModel: opts.implementGeneratorModel } : {}),
        ...(typeof opts.implementEvaluatorProvider === 'string'
          ? { evaluatorProvider: opts.implementEvaluatorProvider }
          : {}),
        ...(typeof opts.implementEvaluatorModel === 'string' ? { evaluatorModel: opts.implementEvaluatorModel } : {}),
      });
      if (!parsed.ok) {
        process.stderr.write(`ralphctl: ${parsed.error}\n`);
        process.exitCode = 1;
        return;
      }
      await launchTui({ ...(parsed.overrides !== undefined ? { implementRoleOverrides: parsed.overrides } : {}) });
    });

  registerExportRequirementsCommand(program);
  registerExportContextCommand(program);
  registerCreatePrCommand(program);
  registerDoctorCommand(program);
  registerSettingsCommand(program);
  registerCompletionCommand(program);
  registerProjectCommand(program);
  registerSprintCommand(program);
  registerTicketCommand(program);
  registerTaskCommand(program);
  registerRunsCommand(program);

  await program.parseAsync([...argv]);
};
