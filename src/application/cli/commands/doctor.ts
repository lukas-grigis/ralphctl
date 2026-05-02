/**
 * `doctor` command — environment health snapshot.
 *
 * Wraps {@link runDoctor} (which is not a chain — see its file header) and
 * formats the report. Exits non-zero only when the report is `fail`; warnings
 * are advisory.
 */
import type { Command } from 'commander';

import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { runDoctor } from '@src/application/doctor/run-doctor.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatDoctorReport } from '@src/application/cli/format/format-doctor.ts';

export function attachDoctor(program: Command, deps: SharedDeps): void {
  program
    .command('doctor')
    .description('environment health check')
    .action(async () => {
      const code = await runDoctorCommand(deps);
      setExitCode(code);
    });
}

export async function runDoctorCommand(deps: SharedDeps): Promise<ExitCode> {
  const report = await runDoctor(deps);
  process.stdout.write(formatDoctorReport(report) + '\n');
  return report.status === 'fail' ? EXIT_ERROR : EXIT_SUCCESS;
}

function setExitCode(code: ExitCode): void {
  if (code !== EXIT_SUCCESS) process.exitCode = code;
}
