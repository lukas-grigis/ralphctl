import type { Command } from 'commander';
import { doctorCommand } from '@src/commands/doctor/doctor.ts';

export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .description('Check environment health and diagnose setup issues')
    .action(async () => {
      await doctorCommand();
    });
}
