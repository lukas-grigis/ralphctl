import type { Command } from 'commander';
import { createDoctorFlow } from '@src/application/flows/doctor/flow.ts';
import { commandExists } from '@src/integration/io/command-exists.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

/**
 * Register the `doctor` CLI command.
 *
 *   ralphctl doctor
 *
 * Runs the same probes the TUI's Doctor view runs (storage roots reachable, project + sprint
 * repositories respond) and prints a one-line summary per probe. Exits 0 when all probes pass,
 * 1 otherwise — suitable for CI / health-check scripts.
 */
export const registerDoctorCommand = (program: Command): void => {
  program
    .command('doctor')
    .description('run sanity probes against storage roots and core repositories')
    .action(async () => {
      const { deps, storage } = await bootstrapCli();
      const flow = createDoctorFlow({
        projectRepo: deps.projectRepo,
        sprintRepo: deps.sprintRepo,
        sprintExecutionRepo: deps.sprintExecutionRepo,
        settingsRepo: deps.settingsRepo,
        commandExists,
        runCommand,
        nodeVersion: process.version,
      });
      const result = await flow.execute({
        input: { dataRoot: storage.dataRoot, configRoot: storage.configRoot },
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.error.message}\n`);
        process.exit(1);
        return;
      }
      const report = result.value.ctx.output!;
      for (const probe of report.probes) {
        const tag = probe.status === 'pass' ? 'OK  ' : probe.status === 'warn' ? 'WARN' : 'FAIL';
        const detail = probe.detail !== undefined ? ` — ${probe.detail}` : '';
        process.stdout.write(`${tag}  ${probe.label}${detail}\n`);
        if (probe.hint !== undefined && probe.status !== 'pass') {
          process.stdout.write(`      hint: ${probe.hint}\n`);
        }
      }
      // Exit non-zero on hard failures (provider CLI missing, repo unreachable). Warnings —
      // notably "settings file not yet persisted on first run" — pass with exit 0 so the
      // welcome flow can resolve them on the next launch without scaring CI scripts.
      process.exit(report.hasFailures ? 1 : 0);
    });
};
