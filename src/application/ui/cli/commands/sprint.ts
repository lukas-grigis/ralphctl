import type { Command } from 'commander';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { activateSprintUseCase } from '@src/business/sprint/activate-sprint.ts';
import { transitionSprintToDoneUseCase } from '@src/business/sprint/transition-sprint-to-done.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

/**
 * Register the `sprint` command group.
 *
 *   ralphctl sprint list
 *   ralphctl sprint show <id>
 *   ralphctl sprint remove <id>
 *   ralphctl sprint activate <id>
 *   ralphctl sprint close <id>
 *   ralphctl sprint set-current <id>
 *   ralphctl sprint progress [id]
 *
 * Read-side ops dispatch directly to `deps.sprintRepo`. Sprint creation is an interactive
 * chain flow (`flows/create-sprint`) that lives in the TUI; surfacing it via CLI would lose
 * the interactive prompts that drive its inputs.
 */
export const registerSprintCommand = (program: Command): void => {
  const sprintCmd = program.command('sprint').description('inspect and manage sprints');

  sprintCmd
    .command('list')
    .description('list all sprints')
    .action(async () => {
      const { deps } = await bootstrapCli();
      const result = await deps.sprintRepo.list();
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      if (result.value.length === 0) {
        process.stdout.write('(no sprints yet — create one in the TUI)\n');
        return;
      }
      for (const s of result.value) {
        process.stdout.write(`${formatSprintLine(s)}\n`);
      }
    });

  sprintCmd
    .command('show <id>')
    .description('print a single sprint as JSON')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const result = await deps.sprintRepo.findById(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    });

  sprintCmd
    .command('remove <id>')
    .description('delete a sprint (cascades to its execution + tasks)')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const result = await deps.sprintRepo.remove(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`removed sprint ${String(id.value)}\n`);
    });

  sprintCmd
    .command('activate <id>')
    .description('transition a planned sprint to active (idempotent — already-active passes through)')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const loaded = await deps.sprintRepo.findById(id.value);
      if (!loaded.ok) {
        process.stderr.write(`error: ${loaded.error.message}\n`);
        process.exit(1);
        return;
      }
      const result = await activateSprintUseCase({
        sprint: loaded.value,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`activated sprint '${result.value.slug}' (${String(result.value.id)})\n`);
    });

  sprintCmd
    .command('close <id>')
    .description('transition a review sprint to done (rejects any other status)')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const loaded = await deps.sprintRepo.findById(id.value);
      if (!loaded.ok) {
        process.stderr.write(`error: ${loaded.error.message}\n`);
        process.exit(1);
        return;
      }
      const result = await transitionSprintToDoneUseCase({
        sprint: loaded.value,
        aborted: false,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
      });
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exit(1);
        return;
      }
      if (result.value === undefined) {
        process.stderr.write('error: close was aborted internally — please retry\n');
        process.exit(1);
        return;
      }
      process.stdout.write(`closed sprint '${result.value.slug}' (${String(result.value.id)})\n`);
    });

  sprintCmd
    .command('set-current <id>')
    .description("pin a sprint as the user's current selection (read by the TUI on launch)")
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps, storage } = await bootstrapCli();
      const sprint = await deps.sprintRepo.findById(id.value);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exit(1);
        return;
      }
      // Re-load the project so the persisted selection is internally consistent — set-current
      // must always pin a sprint UNDER its project so the TUI can route to the correct project
      // view first.
      const project = await deps.projectRepo.findById(sprint.value.projectId);
      if (!project.ok) {
        process.stderr.write(`error: project lookup failed: ${project.error.message}\n`);
        process.exit(1);
        return;
      }
      const store = createLastSelectionStore(storage.stateRoot);
      await store.write({
        projectId: project.value.id,
        projectLabel: project.value.displayName,
        sprintId: sprint.value.id,
      });
      process.stdout.write(`pinned current sprint to '${sprint.value.slug}' (${String(sprint.value.id)})\n`);
    });

  sprintCmd
    .command('progress <id>')
    .description('print task counts, blockers, and the sprint branch for one sprint')
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exit(1);
        return;
      }
      const { deps } = await bootstrapCli();
      const sprint = await deps.sprintRepo.findById(id.value);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exit(1);
        return;
      }
      const tasks = await deps.taskRepo.findBySprintId(id.value);
      if (!tasks.ok) {
        process.stderr.write(`error: ${tasks.error.message}\n`);
        process.exit(1);
        return;
      }
      const execution = await deps.sprintExecutionRepo.findById(id.value);
      const branchLine = execution.ok
        ? execution.value.branch !== null
          ? execution.value.branch
          : '(no branch assigned yet — first implement run will assign one)'
        : '(no execution record — sprint never started)';
      process.stdout.write(formatProgress(sprint.value, tasks.value, branchLine));
    });
};

const formatProgress = (
  sprint: Sprint,
  tasks: ReadonlyArray<{ readonly status: string; readonly name: string }>,
  branchLine: string
): string => {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const lines: string[] = [];
  lines.push(`Progress — ${sprint.name}`);
  lines.push(`  id      ${String(sprint.id)}`);
  lines.push(`  status  ${sprint.status}`);
  lines.push(`  branch  ${branchLine}`);
  lines.push(
    `  tasks   ${String(done)}/${String(total)} done · ${String(inProgress)} in progress · ${String(todo)} todo · ${String(blocked.length)} blocked`
  );
  if (blocked.length > 0) {
    lines.push('');
    lines.push(`Blockers (${String(blocked.length)})`);
    for (const t of blocked) {
      lines.push(`  ✗ ${t.name}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

const formatSprintLine = (s: Sprint): string => {
  const tickets = s.tickets.length;
  return `${String(s.id)}  ${String(s.slug).padEnd(24)}  [${s.status.padEnd(8)}]  ${s.name}  (${String(tickets)} ticket${tickets === 1 ? '' : 's'})`;
};
