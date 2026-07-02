import type { Command } from 'commander';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { confirmDestructive } from '@src/application/ui/cli/confirm-destructive.ts';
import { resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';
import { activateSprintUseCase } from '@src/business/sprint/activate-sprint.ts';
import { transitionSprintToDoneUseCase } from '@src/business/sprint/transition-sprint-to-done.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

interface RemoveOpts {
  readonly yes?: boolean;
}

/**
 * Register the `sprint` command group.
 *
 *   ralphctl sprint list
 *   ralphctl sprint show [id]
 *   ralphctl sprint remove <id>
 *   ralphctl sprint activate <id>
 *   ralphctl sprint close <id>
 *   ralphctl sprint set-current <id>
 *   ralphctl sprint progress [id]
 *
 * `show` and `progress` default their `[id]` to the pinned current sprint (written by
 * `sprint set-current` and the TUI) so inspection doesn't repeat the UUID the user already
 * pinned. Read-side ops dispatch directly to `deps.sprintRepo`. Sprint creation is an
 * interactive chain flow (`flows/create-sprint`) that lives in the TUI; surfacing it via CLI
 * would lose the interactive prompts that drive its inputs.
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
        process.exitCode = 1;
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
    .command('show [id]')
    .description('print a single sprint as JSON (defaults to the current sprint)')
    .action(async (raw?: string) => {
      const { deps, storage } = await bootstrapCli();
      const id = await resolveSprintId(raw, storage.stateRoot, {
        missingMessage: 'no current sprint pinned — run `ralphctl sprint set-current <id>` or pass an id',
      });
      if (!id.ok) {
        process.stderr.write(`error: ${id.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const result = await deps.sprintRepo.findById(id.value.sprintId);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    });

  sprintCmd
    .command('remove <id>')
    .description('delete a sprint (cascades to its execution + tasks)')
    .option('-y, --yes', 'skip the interactive y/N confirmation')
    .action(async (raw: string, opts: RemoveOpts) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      // Mirrors the TUI's ConfirmCard gate on the same sprintRepo.remove call
      // (sprints-view.tsx) — the CLI has no interactive overlay, so a TTY-gated y/N prompt
      // (or --yes for scripts) stands in for it.
      const confirmed = await confirmDestructive({
        yes: opts.yes === true,
        action: `remove sprint ${String(id.value)}`,
        confirmPrompt: `remove sprint ${String(id.value)} (cascades to its execution + tasks)? [y/N] `,
      });
      if (!confirmed) return;

      const { deps, storage } = await bootstrapCli();
      const result = await deps.sprintRepo.remove(id.value);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      // Clear a dangling pin: leaving the removed sprint in last-selection.json would make
      // every defaulting command (and the next TUI boot) resolve to a ghost. The project pin
      // survives — only the sprint slot is dropped (rest-destructure keeps
      // exactOptionalPropertyTypes happy by omitting the key instead of assigning undefined).
      const store = createLastSelectionStore(storage.stateRoot);
      const cur = await store.read();
      if (cur?.sprintId === id.value) {
        const { sprintId: _drop, ...rest } = cur;
        void _drop;
        await store.write(rest);
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
        process.exitCode = 1;
        return;
      }
      const { deps } = await bootstrapCli();
      const loaded = await deps.sprintRepo.findById(id.value);
      if (!loaded.ok) {
        process.stderr.write(`error: ${loaded.error.message}\n`);
        process.exitCode = 1;
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
        process.exitCode = 1;
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
        process.exitCode = 1;
        return;
      }
      const { deps } = await bootstrapCli();
      const loaded = await deps.sprintRepo.findById(id.value);
      if (!loaded.ok) {
        process.stderr.write(`error: ${loaded.error.message}\n`);
        process.exitCode = 1;
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
        process.exitCode = 1;
        return;
      }
      if (result.value === undefined) {
        process.stderr.write('error: close was aborted internally — please retry\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`closed sprint '${result.value.slug}' (${String(result.value.id)})\n`);
    });

  sprintCmd
    .command('set-current <id>')
    .description(
      "pin a sprint as the user's current selection (read by the TUI on launch and used as the default sprint for CLI commands)"
    )
    .action(async (raw: string) => {
      const id = SprintId.parse(raw);
      if (!id.ok) {
        process.stderr.write(`error: invalid sprint id: ${id.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const { deps, storage } = await bootstrapCli();
      const sprint = await deps.sprintRepo.findById(id.value);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      // Re-load the project so the persisted selection is internally consistent — set-current
      // must always pin a sprint UNDER its project so the TUI can route to the correct project
      // view first.
      const project = await deps.projectRepo.findById(sprint.value.projectId);
      if (!project.ok) {
        process.stderr.write(`error: project lookup failed: ${project.error.message}\n`);
        process.exitCode = 1;
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
    .command('progress [id]')
    .description('print task counts, blockers, and the sprint branch (defaults to the current sprint)')
    .action(async (raw?: string) => {
      const { deps, storage } = await bootstrapCli();
      const resolved = await resolveSprintId(raw, storage.stateRoot, {
        missingMessage: 'no current sprint pinned — run `ralphctl sprint set-current <id>` or pass an id',
      });
      if (!resolved.ok) {
        process.stderr.write(`error: ${resolved.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const sprintId = resolved.value.sprintId;
      const sprint = await deps.sprintRepo.findById(sprintId);
      if (!sprint.ok) {
        process.stderr.write(`error: ${sprint.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const tasks = await deps.taskRepo.findBySprintId(sprintId);
      if (!tasks.ok) {
        process.stderr.write(`error: ${tasks.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const execution = await deps.sprintExecutionRepo.findById(sprintId);
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
