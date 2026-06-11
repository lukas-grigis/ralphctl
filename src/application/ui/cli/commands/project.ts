import type { Command } from 'commander';
import type { Project } from '@src/domain/entity/project.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

/**
 * Register the `project` command group.
 *
 *   ralphctl project list
 *   ralphctl project show [id]
 *   ralphctl project remove <id>
 *
 * `show` defaults its `[id]` to the pinned current project (written by the TUI and
 * `sprint set-current`). Read-side ops dispatch directly to `deps.projectRepo` — there's no
 * surrounding logic to encapsulate, so a use-case wrapper would just be ceremony. Project
 * creation lives in the TUI (interactive multi-input flow).
 */
export const registerProjectCommand = (program: Command): void => {
  const project = program.command('project').description('inspect and manage projects');

  project
    .command('list')
    .description('list all registered projects')
    .action(async () => {
      const { deps } = await bootstrapCli();
      const result = await deps.projectRepo.list();
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      if (result.value.length === 0) {
        process.stdout.write('(no projects yet — create one in the TUI)\n');
        return;
      }
      for (const p of result.value) {
        process.stdout.write(`${formatProjectLine(p)}\n`);
      }
    });

  project
    .command('show [id]')
    .description('print a single project as JSON (defaults to the current project)')
    .action(async (raw?: string) => {
      const { deps, storage } = await bootstrapCli();
      // Fall back to the pinned selection when no id is given. The pinned id still funnels
      // through ProjectId.parse — the store's read is silent on corruption, so a stale or
      // hand-edited file must fail with the same message an invalid explicit argument gets.
      let effectiveRaw = raw;
      if (effectiveRaw === undefined) {
        const pinned = await createLastSelectionStore(storage.stateRoot).read();
        if (pinned?.projectId === undefined) {
          process.stderr.write('error: no current project — pick one in the TUI or pass an id\n');
          process.exit(1);
          return;
        }
        effectiveRaw = String(pinned.projectId);
      }
      const id = ProjectId.parse(effectiveRaw);
      if (!id.ok) {
        process.stderr.write(`error: invalid project id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const result = await deps.projectRepo.findById(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    });

  project
    .command('remove <id>')
    .description('delete a project (does not touch sprints or repository contents)')
    .action(async (raw: string) => {
      const id = ProjectId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid project id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps, storage } = await bootstrapCli();
      const result = await deps.projectRepo.remove(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      // Clear a dangling pin: a removed project would otherwise keep resolving as the default
      // for `project show` and re-seed the TUI on next launch. The sprint pin lives under the
      // project, so the whole file goes (write(undefined) deletes it).
      const store = createLastSelectionStore(storage.stateRoot);
      const cur = await store.read();
      if (cur?.projectId === id.value) await store.write(undefined);
      process.stdout.write(`removed project ${String(id.value)}\n`);
    });
};

const formatProjectLine = (p: Project): string => {
  const repos = p.repositories.length;
  return `${String(p.id)}  ${String(p.slug).padEnd(24)}  ${p.displayName}  (${String(repos)} repo${repos === 1 ? '' : 's'})`;
};
