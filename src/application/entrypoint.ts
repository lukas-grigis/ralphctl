import { Command } from 'commander';
import { printBanner, showError } from '@src/integration/ui/theme/ui.ts';
import { registerProjectCommands } from '@src/integration/cli/commands/project/register.ts';
import { registerSprintCommands } from '@src/integration/cli/commands/sprint/register.ts';
import { registerTaskCommands } from '@src/integration/cli/commands/task/register.ts';
import { registerTicketCommands } from '@src/integration/cli/commands/ticket/register.ts';
import { registerProgressCommands } from '@src/integration/cli/commands/progress/register.ts';
import { registerDashboardCommands } from '@src/integration/cli/commands/dashboard/register.ts';
import { registerConfigCommands } from '@src/integration/cli/commands/config/register.ts';
import { registerCompletionCommands } from '@src/integration/cli/commands/completion/register.ts';
import { registerDoctorCommands } from '@src/integration/cli/commands/doctor/register.ts';
import { error } from '@src/integration/ui/theme/theme.ts';
import { cliMetadata } from '@src/application/cli-metadata.ts';
import { DomainError } from '@src/domain/errors.ts';
import { EXIT_ERROR } from '@src/integration/utils/exit-codes.ts';

const program = new Command();
program
  .name(cliMetadata.name)
  .description(cliMetadata.description)
  .version(cliMetadata.version)
  .addHelpText(
    'after',
    `
Examples:
  $ ralphctl                              # Interactive mode
  $ ralphctl status                       # Show current sprint status
  $ ralphctl sprint create --name "v1.0"  # Create sprint
  $ ralphctl ticket add --project api     # Add ticket
  $ ralphctl task list -b                 # Brief task list

Run any command with --help for details.
`
  );

registerProjectCommands(program);
registerSprintCommands(program);
registerTaskCommands(program);
registerTicketCommands(program);
registerProgressCommands(program);
registerDashboardCommands(program);
registerConfigCommands(program);
registerCompletionCommands(program);
registerDoctorCommands(program);

async function main(): Promise<void> {
  // Shell completion: intercept before any output (banner, interactive mode)
  if (process.env['COMP_CWORD'] && process.env['COMP_POINT'] && process.env['COMP_LINE']) {
    const { handleCompletionRequest } = await import('@src/integration/cli/completion/handle.ts');
    if (await handleCompletionRequest(program)) return;
  }

  const argv = process.argv;
  const isBare = argv.length <= 2;
  const isInteractive = argv[2] === 'interactive';

  // Bare invocation or explicit `interactive` → try to mount the Ink REPL.
  if (isBare || isInteractive) {
    const { mountInkApp } = await import('@src/integration/ui/tui/runtime/mount.tsx');
    const { fallback } = await mountInkApp({ initialView: 'repl' });
    if (!fallback) return;
    // Non-TTY bare invocation: no Ink, no interactive menu — print help so
    // scripted callers see the full command surface and can `ralphctl <cmd>`.
    printBanner();
    console.log('');
    console.log('Interactive mode requires a TTY. Available commands:');
    console.log('');
    program.outputHelp();
    return;
  }

  // `ralphctl sprint start ...` — mount Ink in execute mode for TTY users so
  // they get the live dashboard. Non-TTY falls through to commander which
  // runs sprintStartCommand with PlainTextSink output.
  if (argv[2] === 'sprint' && argv[3] === 'start') {
    const { parseSprintStartArgs } = await import('@src/integration/cli/commands/sprint/start.ts');
    const parsed = parseSprintStartArgs(argv.slice(4));
    if (parsed.ok) {
      const { mountInkApp } = await import('@src/integration/ui/tui/runtime/mount.tsx');
      const { getSharedDeps } = await import('@src/application/bootstrap.ts');
      let sprintId: string | undefined;
      try {
        sprintId = await getSharedDeps().persistence.resolveSprintId(parsed.value.sprintId);
      } catch {
        sprintId = undefined;
      }
      if (sprintId) {
        const { fallback } = await mountInkApp({
          initialView: 'execute',
          sprintId,
          executionOptions: parsed.value.options,
        });
        if (!fallback) return;
      }
      // Either no resolvable sprint or non-TTY — fall through to commander
      // which runs the plain-text path with the same args.
    }
  }

  printBanner();
  await program.parseAsync(argv);
}

main().catch((err: unknown) => {
  if (err instanceof DomainError) {
    // Domain errors carry user-facing messages — display them cleanly
    showError(err.message);
    process.exit(EXIT_ERROR);
  }
  // Truly unexpected errors (programming bugs, unhandled edge cases)
  console.error(error('Unexpected error — please report this bug:'), err instanceof Error ? err.stack : String(err));
  process.exit(EXIT_ERROR);
});
