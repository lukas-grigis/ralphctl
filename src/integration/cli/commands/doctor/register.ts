import type { Command } from 'commander';
import { doctorCommand } from '@src/integration/cli/commands/doctor/doctor.ts';

export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .description('Check environment health and diagnose setup issues')
    .addHelpText(
      'after',
      `
Examples:
  $ ralphctl doctor                         # Run all health checks

Checks performed:
  - Node.js version (>= 24)
  - Git installation and identity
  - AI provider binary (claude or copilot)
  - Data directory accessibility
  - Project repository paths
  - Current sprint validity`
    )
    .action(async () => {
      await doctorCommand();
    });
}
