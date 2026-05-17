import type { Command } from 'commander';
import type { Project } from '@src/domain/entity/project.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';

/**
 * Register the `project` command group.
 *
 *   ralphctl project list
 *   ralphctl project show <id>
 *   ralphctl project remove <id>
 *
 * Read-side ops dispatch directly to `deps.projectRepo` — there's no surrounding logic to
 * encapsulate, so a use-case wrapper would just be ceremony. Project creation lives in the
 * TUI (interactive multi-input flow).
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
    .command('show <id>')
    .description('print a single project as JSON')
    .action(async (raw: string) => {
      const id = ProjectId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid project id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
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
      const { deps } = await bootstrapCli();
      const result = await deps.projectRepo.remove(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`removed project ${String(id.value)}\n`);
    });
};

const formatProjectLine = (p: Project): string => {
  const repos = p.repositories.length;
  return `${String(p.id)}  ${String(p.slug).padEnd(24)}  ${p.displayName}  (${String(repos)} repo${repos === 1 ? '' : 's'})`;
};
