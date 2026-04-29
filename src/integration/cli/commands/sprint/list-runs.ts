import { listRuns, pruneStale, type RunState } from '@src/integration/runtime/runs-store.ts';
import { colors } from '@src/integration/ui/theme/theme.ts';
import { icons, log, printHeader, renderTable, showEmpty } from '@src/integration/ui/theme/ui.ts';

function formatRunStatus(status: RunState['status']): string {
  switch (status) {
    case 'running':
      return colors.success(`${icons.active} running`);
    case 'completed':
      return colors.success(`${icons.success} completed`);
    case 'failed':
      return colors.error(`${icons.error} failed`);
    case 'cancelled':
      return colors.muted(`${icons.inactive} cancelled`);
  }
}

function formatStartedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export async function sprintListRunsCommand(): Promise<void> {
  // Reconcile dead daemons before rendering so the table is honest.
  await pruneStale();
  const runs = await listRuns();

  printHeader('Sprint Runs', icons.sprint);

  if (runs.length === 0) {
    showEmpty('runs', 'Start a sprint with: ralphctl sprint start');
    return;
  }

  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const rows: string[][] = sorted.map((run) => [
    formatRunStatus(run.status),
    run.projectName,
    run.sprintId,
    formatStartedAt(run.startedAt),
    String(run.pid),
    run.executionId,
  ]);

  console.log(
    renderTable(
      [
        { header: 'Status' },
        { header: 'Project' },
        { header: 'Sprint' },
        { header: 'Started' },
        { header: 'PID', align: 'right' },
        { header: 'Run ID' },
      ],
      rows
    )
  );

  log.newline();
  const runningCount = runs.filter((r) => r.status === 'running').length;
  log.dim(`Showing ${String(runs.length)} run(s) — ${String(runningCount)} running`);
  log.newline();
}
