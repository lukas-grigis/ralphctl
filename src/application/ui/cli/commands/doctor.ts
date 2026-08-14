import type { Command } from 'commander';
import { createDoctorFlow } from '@src/application/flows/doctor/flow.ts';
import type { ProbeResult, ProbeStatus } from '@src/application/flows/doctor/ctx.ts';
import { commandExists } from '@src/integration/io/command-exists.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';

/** Fixed-width tag prefixing each probe line — every value is 4 characters for column alignment. */
const PROBE_TAG: Readonly<Record<ProbeStatus, string>> = { pass: 'OK  ', warn: 'WARN', unknown: 'UNK ', fail: 'FAIL' };

const printProbe = (probe: ProbeResult): void => {
  const detail = probe.detail !== undefined ? ` — ${probe.detail}` : '';
  process.stdout.write(`${PROBE_TAG[probe.status]}  ${probe.label}${detail}\n`);
  if (probe.hint !== undefined && probe.status !== 'pass') {
    process.stdout.write(`      hint: ${probe.hint}\n`);
  }
};

const doctorAction = async (): Promise<void> => {
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
    fail(result.error.error.message);
    return;
  }
  const report = result.value.ctx.output!;
  for (const probe of report.probes) printProbe(probe);
  // Exit non-zero on hard failures (provider CLI missing, repo unreachable). Warnings —
  // notably "settings file not yet persisted on first run" — pass with exit 0 so the
  // welcome flow can resolve them on the next launch without scaring CI scripts. Setting
  // exitCode (not process.exit) lets pending stdout writes above flush before Node exits.
  process.exitCode = report.hasFailures ? 1 : 0;
};

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
    .action(doctorAction);
};
