/**
 * `ralphctl snapshot [--sprint <id>]` — render one static text frame of the active sprint to
 * stdout. No Ink mount; useful for docs screenshots, bug reports, and CI inspection.
 *
 * Sprint resolution:
 *  1. `--sprint <id>` argument wins, if supplied (validated through `SprintId.parse`).
 *  2. Otherwise the pinned sprint from `last-selection-store` is used (matches the TUI's
 *     auto-pick behaviour).
 *  3. If neither is set, exit code 1 with a friendly message that points at `sprint set-current`.
 *
 * Exit codes:
 *  - 0 on a successful render
 *  - 1 when no sprint is loaded, the sprint id doesn't exist, or persistence read fails
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';
import { projectSprintState } from '@src/business/sprint/state-projection.ts';
import { renderSnapshotText } from '@src/business/sprint/render-snapshot-text.ts';

interface SnapshotOpts {
  readonly sprint?: string;
}

export const registerSnapshotCommand = (program: Command): void => {
  program
    .command('snapshot')
    .description('print one static text frame of the active sprint state to stdout')
    .option(
      '--sprint <id>',
      'sprint to snapshot (defaults to the pinned current sprint via `ralphctl sprint set-current`)'
    )
    .action(async (opts: SnapshotOpts) => {
      await runSnapshotCommand(opts);
    });
};

const runSnapshotCommand = async (opts: SnapshotOpts): Promise<void> => {
  const { deps, storage } = await bootstrapCli();

  // Resolve the sprint id from the flag first, then from the persisted "current" selection.
  const sprintId = await resolveSprintId(opts.sprint, storage.stateRoot);
  if (sprintId === undefined) {
    process.stderr.write(
      'error: no sprint to snapshot — pass `--sprint <id>` or pin one via `ralphctl sprint set-current <id>`\n'
    );
    process.exit(1);
    return;
  }

  const sprint = await deps.sprintRepo.findById(sprintId);
  if (!sprint.ok) {
    process.stderr.write(`error: ${sprint.error.message}\n`);
    process.exit(1);
    return;
  }
  const tasks = await deps.taskRepo.findBySprintId(sprintId);
  if (!tasks.ok) {
    process.stderr.write(`error: ${tasks.error.message}\n`);
    process.exit(1);
    return;
  }
  const execution = await deps.sprintExecutionRepo.findById(sprintId);
  if (!execution.ok) {
    process.stderr.write(`error: ${execution.error.message}\n`);
    process.exit(1);
    return;
  }

  // Chain log is best-effort: a missing file is fine (fresh sprint with no implement runs);
  // any other read failure surfaces an empty log and the snapshot still renders the entities.
  const chainLogPath = sprintChainLogPath(storage.dataRoot, sprintId);
  const chainLog = await deps.loadChainLog(chainLogPath);
  const chainLogEntries = chainLog.ok ? chainLog.value : [];

  // Project label — sourced from the project repo so we don't surface "(no project)" when the
  // sprint is part of a project the persisted last-selection happens not to cover.
  const project = await deps.projectRepo.findById(sprint.value.projectId);
  const projectLabel = project.ok ? project.value.displayName : undefined;

  const state = projectSprintState({
    sprint: sprint.value,
    execution: execution.value,
    tasks: tasks.value,
    chainLogEntries,
    now: IsoTimestamp.now(),
  });

  const text = renderSnapshotText({
    state,
    chainLogEntries,
    ...(projectLabel !== undefined ? { projectLabel } : {}),
  });
  process.stdout.write(text);
};

const resolveSprintId = async (raw: string | undefined, stateRoot: AbsolutePath): Promise<SprintId | undefined> => {
  if (raw !== undefined) {
    const parsed = SprintId.parse(raw);
    if (!parsed.ok) {
      process.stderr.write(`error: invalid sprint id: ${parsed.error.message}\n`);
      process.exit(1);
      return undefined;
    }
    return parsed.value;
  }
  const store = createLastSelectionStore(stateRoot);
  const selection = await store.read();
  return selection?.sprintId;
};

const sprintChainLogPath = (dataRoot: AbsolutePath, sprintId: SprintId): AbsolutePath => {
  const path = AbsolutePath.parse(join(String(dataRoot), 'sprints', String(sprintId), 'chain.log'));
  // dataRoot is already absolute, so the join always yields an absolute path; the parse should
  // never fail. If it does, bubble up via process.exit so the user sees a sensible message.
  if (!path.ok) {
    process.stderr.write(`error: failed to build chain.log path: ${path.error.message}\n`);
    process.exit(1);
    throw new Error('unreachable'); // satisfies TS noreturn flow
  }
  return path.value;
};
