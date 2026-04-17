import { showDashboard } from '@src/integration/ui/tui/views/dashboard-data.ts';

export async function dashboardCommand(): Promise<void> {
  await showDashboard();
}
