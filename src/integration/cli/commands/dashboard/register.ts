import type { Command } from 'commander';
import { dashboardCommand } from '@src/integration/cli/commands/dashboard/dashboard.ts';

export function registerDashboardCommands(program: Command): void {
  program.command('status').description('Show current sprint overview').action(dashboardCommand);
}
