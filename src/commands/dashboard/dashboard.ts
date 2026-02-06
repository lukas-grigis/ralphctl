import { showDashboard } from '@src/interactive/dashboard.ts';

export async function dashboardCommand(): Promise<void> {
  await showDashboard();
}
