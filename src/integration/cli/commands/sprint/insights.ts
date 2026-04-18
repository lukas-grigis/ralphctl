import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { getCurrentSprintOrThrow, getSprint } from '@src/integration/persistence/sprint.ts';
import { getTasks } from '@src/integration/persistence/task.ts';
import { getDataDir } from '@src/integration/persistence/paths.ts';
import { ensureDir } from '@src/integration/persistence/storage.ts';
import { colors } from '@src/integration/ui/theme/theme.ts';
import { icons, log, printHeader, showError } from '@src/integration/ui/theme/ui.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import { truncate } from '@src/domain/strings.ts';

export async function sprintInsightsCommand(args: string[]): Promise<void> {
  const exportFlag = args.includes('--export');
  const positionalArgs = args.filter((a) => !a.startsWith('--'));
  const sprintId = positionalArgs[0];

  const sprintR = await wrapAsync(async () => {
    if (sprintId) return getSprint(sprintId);
    return getCurrentSprintOrThrow();
  }, ensureError);

  if (!sprintR.ok) {
    showError(sprintR.error.message);
    return;
  }

  const sprint: Sprint = sprintR.value;
  const tasks = await getTasks(sprint.id);

  printHeader(`Sprint Insights: ${sprint.name}`, icons.sprint);

  const evaluatedTasks = tasks.filter((t) => t.evaluated);

  if (evaluatedTasks.length === 0) {
    log.info('No evaluation data found for this sprint.');
    return;
  }

  const totalTasks = tasks.length;
  const evaluatedCount = evaluatedTasks.length;
  const withOutput = evaluatedTasks.filter((t) => t.evaluationOutput && t.evaluationOutput.trim().length > 0);

  console.log(`  Tasks evaluated: ${colors.accent(String(evaluatedCount))} / ${String(totalTasks)} total`);
  log.newline();

  if (withOutput.length > 0) {
    console.log(`  ${colors.accent('Evaluation output:')}`);
    for (const task of withOutput) {
      const output = task.evaluationOutput ?? '';
      const truncated = truncate(output, 200);
      console.log(`    ${icons.bullet} ${colors.accent(task.name)}: ${colors.muted(truncated)}`);
    }
    log.newline();
  }

  console.log(`  ${colors.accent('Harness recommendations:')}`);
  if (withOutput.length > 1) {
    console.log(
      `    ${icons.bullet} Consider reviewing evaluation failure patterns and updating CLAUDE.md with lessons learned.`
    );
  }
  if (withOutput.length > 0) {
    console.log(
      `    ${icons.bullet} Run: ${colors.muted('ralphctl sprint insights --export')} to save details to $RALPHCTL_ROOT/insights/<sprint-id>.md`
    );
  }
  log.newline();

  if (exportFlag) {
    await exportInsights(sprint, tasks);
  }
}

async function exportInsights(sprint: Sprint, tasks: Task[]): Promise<void> {
  const dir = join(getDataDir(), 'insights');
  await ensureDir(dir);

  const filePath = join(dir, `${sprint.id}.md`);
  const evaluatedCount = tasks.filter((t) => t.evaluated).length;

  const lines: string[] = [
    `# Sprint Insights: ${sprint.name}`,
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Sprint ID:** ${sprint.id}`,
    `**Tasks evaluated:** ${String(evaluatedCount)} / ${String(tasks.length)} total`,
    '',
    '## Evaluation Details',
  ];

  for (const task of tasks) {
    lines.push('');
    lines.push(`### ${task.name} (${task.id})`);
    lines.push(`**Status:** ${task.status}`);
    lines.push(`**Evaluated:** ${task.evaluated ? 'yes' : 'no'}`);
    lines.push('');
    lines.push(task.evaluationOutput ?? 'No evaluation output');
    lines.push('');
    lines.push('---');
  }

  await writeFile(filePath, lines.join('\n'), 'utf-8');
  log.success(`Insights exported to ${colors.accent(filePath)}`);
}
