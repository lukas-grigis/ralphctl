import { Command } from 'commander';
import { flowRegistry } from '@src/application/registry.ts';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { parseImplementRoleOverrides } from '@src/application/ui/cli/parse-implement-role-overrides.ts';
import { reportFatal } from '@src/application/ui/cli/report-cli-error.ts';
import { registerExportRequirementsCommand } from '@src/application/ui/cli/commands/export-requirements.ts';
import { registerExportContextCommand } from '@src/application/ui/cli/commands/export-context.ts';
import { registerCreatePrCommand } from '@src/application/ui/cli/commands/create-pr.ts';
import { registerDoctorCommand } from '@src/application/ui/cli/commands/doctor.ts';
import { registerDemoCommand } from '@src/application/ui/cli/commands/demo.ts';
import { registerSettingsCommand } from '@src/application/ui/cli/commands/settings.ts';
import { registerCompletionCommand } from '@src/application/ui/cli/commands/completion.ts';
import { registerProjectCommand } from '@src/application/ui/cli/commands/project.ts';
import { registerSprintCommand } from '@src/application/ui/cli/commands/sprint.ts';
import { registerTicketCommand } from '@src/application/ui/cli/commands/ticket.ts';
import { registerTaskCommand } from '@src/application/ui/cli/commands/task.ts';
import { registerRunsCommand } from '@src/application/ui/cli/commands/runs.ts';
import { registerAgentsCommand } from '@src/application/ui/cli/commands/agents.ts';
import { registerSkillsCommand } from '@src/application/ui/cli/commands/skills.ts';
import { registerPromptsCommand } from '@src/application/ui/cli/commands/prompts.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

/** Build and run the CLI. */
export const runCli = async (argv: readonly string[]): Promise<void> => {
  const program = new Command();

  program
    .name('ralphctl')
    .description('ralphctl — interactive TUI and CLI')
    .version(CLI_METADATA.currentVersion, '-v, --version', 'show version')
    // The root command accepts zero positional args (bare `ralphctl` launches the TUI).
    .allowExcessArguments(true)
    // Per-launch implement-role overrides. Each role is a {provider, model} pair — both flags must be supplied
    // together for a role; supplying only one half errors out below.
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
    .action(async (opts: Record<string, unknown>, command: Command) => {
      // An unrecognized first operand lands here (the root action) because there is no matching subcommand.
      const verb = command.args[0];
      if (verb !== undefined) {
        const isFlow = flowRegistry.some((entry) => entry.manifest.id === verb);
        const flowHint = isFlow ? ` — '${verb}' is an interactive flow — launch the TUI with bare 'ralphctl'` : '';
        process.stderr.write(
          `error: unknown command '${verb}' — run 'ralphctl --help' for available commands${flowHint}\n`
        );
        process.exitCode = 1;
        return;
      }

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
  registerDemoCommand(program);
  registerSettingsCommand(program);
  registerCompletionCommand(program);
  registerProjectCommand(program);
  registerSprintCommand(program);
  registerTicketCommand(program);
  registerTaskCommand(program);
  registerRunsCommand(program);
  registerAgentsCommand(program);
  registerSkillsCommand(program);
  registerPromptsCommand(program);

  // Terminal frame for the whole CLI: every `bootstrapCli` pre-flight throws a plain `Error`, and command actions can
  // throw too.
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    reportFatal(err);
  }
};
