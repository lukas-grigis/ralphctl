/**
 * `sprint progress [id]` — render sprint progress + diagnostics.
 *
 * Folds the legacy `sprint health` command into this one — blockers,
 * stale tasks, dependency cycles, and branch consistency render inline
 * alongside the timeline tail.
 *
 * Flags:
 *  - `--log` print the full timeline only (no diagnostics summary).
 *  - `--lines <n>` cap the timeline tail (default 50).
 */
import { join } from 'node:path';

import type { Command } from 'commander';
import * as c from 'colorette';

import {
  ShowProgressUseCase,
  type ProgressReport,
  STALE_THRESHOLD_HOURS,
} from '../../../business/usecases/sprint/show-progress.ts';
import { Result } from '../../../domain/result.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import { SprintId as SprintIdNs } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

interface ProgressOptions {
  log?: boolean;
  lines?: string;
}

export function attachSprintProgress(group: Command, deps: SharedDeps): void {
  group
    .command('progress [id]')
    .description('show sprint progress, blockers, stale tasks, and dependency cycles')
    .option('--log', 'print the full timeline only (no diagnostics summary)')
    .option('--lines <n>', 'cap the number of timeline entries shown', '50')
    .action(async (id: string | undefined, opts: ProgressOptions) => {
      const code = await runSprintProgress(deps, id, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

function resolveSprintId(deps: SharedDeps, id: string | undefined): Promise<Result<SprintId, Error>> {
  if (id !== undefined && id.length > 0) {
    const parsed = SprintIdNs.parse(id);
    if (!parsed.ok) return Promise.resolve(Result.error(new Error(parsed.error.message)));
    return Promise.resolve(Result.ok(parsed.value));
  }
  return deps.configStore.load().then((loaded) => {
    if (!loaded.ok) return Result.error(new Error(loaded.error.message));
    if (loaded.value.currentSprint === null) {
      return Result.error(new Error('no current sprint set — pass <id> or run `ralphctl sprint set-current`'));
    }
    return Result.ok(loaded.value.currentSprint);
  });
}

export async function runSprintProgress(
  deps: SharedDeps,
  id: string | undefined,
  opts: ProgressOptions
): Promise<ExitCode> {
  const lines = parsePositiveInt(opts.lines, 50);
  return runCommand({
    deps,
    body: async () => {
      const idR = await resolveSprintId(deps, id);
      if (!idR.ok) {
        // Translate the friendly error into a domain-shaped error so
        // runCommand's printer renders consistently.
        const { ValidationError } = await import('../../../domain/values/validation-error.ts');
        return Result.error(
          new ValidationError({
            field: 'sprint.id',
            value: id,
            message: idR.error.message,
          })
        );
      }
      const uc = new ShowProgressUseCase(
        deps.sprintRepo,
        deps.taskRepo,
        deps.projectRepo,
        deps.external,
        undefined,
        (sprintId) => join(String(deps.storage.sprintsDir), String(sprintId), 'progress.md')
      );
      return uc.execute({ sprintId: idR.value, now: IsoTimestamp.now() });
    },
    format: (_d, report) => formatProgress(report, { log: opts.log === true, maxLines: lines }),
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

interface FormatOptions {
  readonly log: boolean;
  readonly maxLines: number;
}

export function formatProgress(report: ProgressReport, opts: FormatOptions): string {
  const lines: string[] = [];

  if (opts.log) {
    lines.push(c.bold(`Progress timeline — ${report.sprintName}`));
    appendTimeline(lines, report.timeline, Number.POSITIVE_INFINITY);
    return lines.join('\n');
  }

  // Header
  lines.push(c.bold(`Progress — ${report.sprintName}`));
  lines.push(`  ${c.dim('id     ')} ${String(report.sprintId)}`);
  lines.push(`  ${c.dim('status ')} ${formatStatus(report.sprintStatus)}`);
  lines.push(`  ${c.dim('tasks  ')} ${countSummary(report)}`);

  // Diagnostics — only print sections that have content.
  if (report.blockers.length > 0) {
    lines.push('');
    lines.push(c.red(c.bold(`Blockers (${String(report.blockers.length)})`)));
    for (const row of report.blockers) {
      lines.push(`  ${c.red('✗')} ${row.task.name} ${c.dim('—')} ${row.reason}`);
    }
  }

  if (report.staleTasks.length > 0) {
    lines.push('');
    lines.push(
      c.yellow(c.bold(`Stale tasks (>${String(STALE_THRESHOLD_HOURS)}h, ${String(report.staleTasks.length)})`))
    );
    for (const row of report.staleTasks) {
      lines.push(`  ${c.yellow('⚠')} ${row.task.name} ${c.dim('—')} ${String(row.hoursStale)}h since last signal`);
    }
  }

  if (report.dependencyCycle !== null && report.dependencyCycle.length > 0) {
    lines.push('');
    lines.push(c.red(c.bold('Dependency cycle')));
    lines.push(`  ${report.dependencyCycle.map((id) => String(id)).join(' → ')}`);
  }

  if (report.branchInconsistency.length > 0) {
    lines.push('');
    lines.push(c.yellow(c.bold(`Branch inconsistency (${String(report.branchInconsistency.length)})`)));
    for (const row of report.branchInconsistency) {
      lines.push(
        `  ${c.yellow('⚠')} ${String(row.repoPath)} ${c.dim('expected')} ${row.expected} ${c.dim('actual')} ${row.actual}`
      );
    }
  }

  // Timeline tail.
  lines.push('');
  lines.push(c.bold(`Timeline (last ${String(opts.maxLines)})`));
  appendTimeline(lines, report.timeline, opts.maxLines);

  return lines.join('\n');
}

function formatStatus(status: ProgressReport['sprintStatus']): string {
  switch (status) {
    case 'draft':
      return c.yellow(status);
    case 'active':
      return c.green(status);
    case 'closed':
      return c.gray(status);
    case 'blocked':
      return c.red(c.bold(status));
  }
}

function countSummary(report: ProgressReport): string {
  const total = report.tasks.length;
  const done = report.tasks.filter((t) => t.status === 'done').length;
  const inProgress = report.tasks.filter((t) => t.status === 'in_progress').length;
  const blocked = report.blockers.length;
  return `${String(done)}/${String(total)} done · ${String(inProgress)} in progress · ${String(blocked)} blocked`;
}

function appendTimeline(lines: string[], timeline: ProgressReport['timeline'], maxLines: number): void {
  if (timeline.length === 0) {
    lines.push(c.dim('  (no timeline entries yet)'));
    return;
  }
  const slice = timeline.slice(Math.max(0, timeline.length - maxLines));
  for (const entry of slice) {
    if (entry.timestamp.length === 0) {
      lines.push(`  ${entry.line}`);
    } else {
      lines.push(`  ${c.dim(entry.timestamp)}  ${entry.line}`);
    }
  }
}
