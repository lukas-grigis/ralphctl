import { join } from 'node:path';
import type { Command } from 'commander';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import { confirmDestructive } from '@src/application/ui/cli/confirm-destructive.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { resolveSprintId } from '@src/application/ui/cli/resolve-sprint-selection.ts';
import { activateSprintUseCase } from '@src/business/sprint/activate-sprint.ts';
import { reopenDoneSprintUseCase } from '@src/business/sprint/reopen-sprint.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { sprintDir as buildSprintDir } from '@src/integration/persistence/storage.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';

interface RemoveOpts {
  readonly yes?: boolean;
}

interface CloseOpts {
  readonly yes?: boolean;
}

/** Longest task-name list spelled out before the tail collapses to "and N more" — mirrors
 *  close-sprint's own in-chain `confirm-blocked-tasks` leaf so the CLI and TUI read the same. */
const MAX_NAMED_BLOCKED_TASKS = 5;

const nameBlockedTasks = (blocked: readonly Task[]): string => {
  const named = blocked.slice(0, MAX_NAMED_BLOCKED_TASKS).map((t) => t.name);
  const remainder = blocked.length - named.length;
  return remainder > 0 ? `${named.join(', ')}, and ${String(remainder)} more` : named.join(', ');
};

const listSprintsAction = async (): Promise<void> => {
  const { deps } = await bootstrapCli();
  const result = await deps.sprintRepo.list();
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  if (result.value.length === 0) {
    process.stdout.write('(no sprints yet — create one in the TUI)\n');
    return;
  }
  for (const s of result.value) {
    process.stdout.write(`${formatSprintLine(s)}\n`);
  }
};

const showSprintAction = async (raw?: string): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const id = await resolveSprintId(raw, storage.stateRoot, {
    missingMessage: 'no current sprint pinned — run `ralphctl sprint set-current <id>` or pass an id',
  });
  if (!id.ok) {
    fail(id.error.message);
    return;
  }
  const result = await deps.sprintRepo.findById(id.value.sprintId);
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
};

const removeSprintAction = async (raw: string, opts: RemoveOpts): Promise<void> => {
  const id = SprintId.parse(raw);
  if (!id.ok) {
    fail(`invalid sprint id: ${id.error.message}`);
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
    fail(result.error.message);
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
};

const activateSprintAction = async (raw: string): Promise<void> => {
  const id = SprintId.parse(raw);
  if (!id.ok) {
    fail(`invalid sprint id: ${id.error.message}`);
    return;
  }
  const { deps } = await bootstrapCli();
  const loaded = await deps.sprintRepo.findById(id.value);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }
  const result = await activateSprintUseCase({
    sprint: loaded.value,
    sprintRepo: deps.sprintRepo,
    clock: deps.clock,
    logger: deps.logger,
  });
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  process.stdout.write(`activated sprint '${result.value.slug}' (${String(result.value.id)})\n`);
};

/**
 * `sprint reopen` is the deliberate exit from an otherwise-terminal `done` sprint — the operator
 * closed it with work still blocked and now wants that work runnable again. It lands in `review`,
 * not `active`: the only review → active step is the domain `revertSprintToActive`, which has no
 * direct CLI surface — `task unblock` is the sole caller, running it automatically as part of its
 * own done → review hop — so there is only ever one done → review transition to keep in sync.
 * Idempotent — an already-`review` sprint passes through unchanged, and the printed output says
 * so instead of claiming a transition that `reopenDoneSprintUseCase` never persisted.
 */
const reopenSprintAction = async (raw: string): Promise<void> => {
  const id = SprintId.parse(raw);
  if (!id.ok) {
    fail(`invalid sprint id: ${id.error.message}`);
    return;
  }
  const { deps } = await bootstrapCli();
  const loaded = await deps.sprintRepo.findById(id.value);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }
  const wasAlreadyReview = loaded.value.status === 'review';
  const result = await reopenDoneSprintUseCase({
    sprint: loaded.value,
    sprintRepo: deps.sprintRepo,
    clock: deps.clock,
    logger: deps.logger,
  });
  if (!result.ok) {
    fail(result.error.message);
    return;
  }
  const transitionLine = wasAlreadyReview
    ? `sprint '${result.value.slug}' (${String(result.value.id)}) is already in review — nothing to reopen\n`
    : `reopened sprint '${result.value.slug}' (${String(result.value.id)}) done → review\n`;
  process.stdout.write(
    `${transitionLine}  unblock its blocked tasks (ralphctl task unblock <id>) to make them runnable again\n`
  );
};

/**
 * `sprint close` shares the same `close-sprint` chain the TUI's `launchCloseSprint` builds
 * (load-and-assert-sprint → refresh-memory-mirror → transition-to-done → journal separator) so
 * closing from the CLI leaves the exact same on-disk state — including the always-on
 * `learnings.md` mirror refresh and the `progress.md` closing separator — instead of forking a
 * bare `transitionSprintToDoneUseCase` call that silently skipped both. Unlike the TUI launcher,
 * the CLI has no interactive HITL surface, so distill (the opt-in learnings-promotion step) is
 * never offered here — `distillRequested` is hardcoded `false` and `deps.distill` is omitted,
 * which the flow reads as "skip the distill step entirely". `deps.blockedTasksGate` is omitted
 * for the same reason (it requires a full `InteractivePrompt`, and `createInkInteractivePrompt`
 * is the only implementation, TUI-only) — the CLI's own confirm below stands in for it.
 *
 * Product decision: closing with blocked tasks is confirm-and-proceed, never a refusal — an
 * operator descoping the remainder is a legitimate call. `-y/--yes` skips the prompt via the same
 * `confirmDestructive` gate `sprint remove` uses; a non-TTY stdin without `--yes` refuses (exit 1)
 * rather than hanging on a prompt nobody can answer. Once the close does proceed — confirmed on a
 * TTY, or via `--yes` — it prints which tasks stayed blocked so the outcome is on the record, not
 * silent.
 */
const closeSprintAction = async (raw: string, opts: CloseOpts): Promise<void> => {
  const id = SprintId.parse(raw);
  if (!id.ok) {
    fail(`invalid sprint id: ${id.error.message}`);
    return;
  }
  const { deps, storage } = await bootstrapCli();
  const loaded = await deps.sprintRepo.findById(id.value);
  if (!loaded.ok) {
    fail(loaded.error.message);
    return;
  }
  const sprint = loaded.value;

  const tasksLoaded = await deps.taskRepo.findBySprintId(sprint.id);
  if (!tasksLoaded.ok) {
    // A failed read is not evidence the sprint is clean — proceeding as if nothing were blocked
    // would silently close over a task list we never actually looked at. Refuse loudly instead,
    // matching every other repo read in this file (e.g. progressSprintAction below).
    fail(tasksLoaded.error.message);
    return;
  }
  const blockedTasks = tasksLoaded.value.filter((t) => t.status === 'blocked');
  if (blockedTasks.length > 0) {
    const confirmed = await confirmDestructive({
      yes: opts.yes === true,
      action: `close sprint ${String(sprint.id)} with ${String(blockedTasks.length)} task(s) still blocked: ${nameBlockedTasks(blockedTasks)}`,
      confirmPrompt: `${String(blockedTasks.length)} task(s) are blocked: ${nameBlockedTasks(blockedTasks)}. Closing won't refuse, but a done sprint needs reopening (unblock one to do that) before they can run again. Close anyway? [y/N] `,
    });
    if (!confirmed) return;
  }

  const sprintDir = buildSprintDir(storage.dataRoot, sprint.id, sprint.slug);
  const progressPath = AbsolutePath.parse(join(sprintDir, 'progress.md'));
  if (!progressPath.ok) {
    fail(progressPath.error.message);
    return;
  }

  // Always-on durable narrative-tier refresh, mirroring the TUI launcher: regenerate
  // `learnings.md` from the per-project ledger at close whenever a project resolves.
  const project = await deps.projectRepo.findById(sprint.projectId);
  const memoryMirror = project.ok
    ? { writeFile: deps.writeFile, memoryRoot: storage.memoryRoot, projectId: String(project.value.id) }
    : undefined;

  const element = createCloseSprintFlow({
    sprintRepo: deps.sprintRepo,
    clock: deps.clock,
    logger: deps.logger,
    appendFile: deps.appendFile,
    progressFile: progressPath.value,
    ...(memoryMirror !== undefined ? { memoryMirror } : {}),
  });
  const runner = createRunner<CloseSprintCtx>({
    id: `cli-sprint-close-${String(id.value)}`,
    element,
    initialCtx: { sprintId: id.value, distillRequested: false },
  });
  let failure: DomainError | undefined;
  const unsubscribe = runner.subscribe((event) => {
    if (event.type === 'failed') failure = event.error;
  });
  await runner.start();
  unsubscribe();

  if (runner.status === 'aborted') {
    fail('close was aborted internally — please retry');
    return;
  }
  if (runner.status === 'failed') {
    fail(failure?.message ?? 'sprint close failed');
    return;
  }
  const closed = runner.ctx.sprint;
  if (closed === undefined) {
    fail('close completed but returned no sprint — please retry');
    return;
  }
  process.stdout.write(`closed sprint '${closed.slug}' (${String(closed.id)})\n`);
  // Record the outcome even when --yes skipped the confirm above — the operator (or a script)
  // should never have to re-run `sprint progress` just to learn what was left behind.
  if (blockedTasks.length > 0) {
    process.stdout.write(
      `  note: ${String(blockedTasks.length)} task(s) stayed blocked: ${nameBlockedTasks(blockedTasks)}\n` +
        `  recover with: ralphctl task unblock <id> (reopens this sprint automatically)\n`
    );
  }
};

const setCurrentSprintAction = async (raw: string): Promise<void> => {
  const id = SprintId.parse(raw);
  if (!id.ok) {
    fail(`invalid sprint id: ${id.error.message}`);
    return;
  }
  const { deps, storage } = await bootstrapCli();
  const sprint = await deps.sprintRepo.findById(id.value);
  if (!sprint.ok) {
    fail(sprint.error.message);
    return;
  }
  // Re-load the project so the persisted selection is internally consistent — set-current
  // must always pin a sprint UNDER its project so the TUI can route to the correct project
  // view first.
  const project = await deps.projectRepo.findById(sprint.value.projectId);
  if (!project.ok) {
    fail(`project lookup failed: ${project.error.message}`);
    return;
  }
  const store = createLastSelectionStore(storage.stateRoot);
  await store.write({
    projectId: project.value.id,
    projectLabel: project.value.displayName,
    sprintId: sprint.value.id,
  });
  process.stdout.write(`pinned current sprint to '${sprint.value.slug}' (${String(sprint.value.id)})\n`);
};

const progressSprintAction = async (raw?: string): Promise<void> => {
  const { deps, storage } = await bootstrapCli();
  const resolved = await resolveSprintId(raw, storage.stateRoot, {
    missingMessage: 'no current sprint pinned — run `ralphctl sprint set-current <id>` or pass an id',
  });
  if (!resolved.ok) {
    fail(resolved.error.message);
    return;
  }
  const sprintId = resolved.value.sprintId;
  const sprint = await deps.sprintRepo.findById(sprintId);
  if (!sprint.ok) {
    fail(sprint.error.message);
    return;
  }
  const tasks = await deps.taskRepo.findBySprintId(sprintId);
  if (!tasks.ok) {
    fail(tasks.error.message);
    return;
  }
  const execution = await deps.sprintExecutionRepo.findById(sprintId);
  const branchLine = execution.ok
    ? execution.value.branch !== null
      ? execution.value.branch
      : '(no branch assigned yet — first implement run will assign one)'
    : '(no execution record — sprint never started)';
  process.stdout.write(formatProgress(sprint.value, tasks.value, branchLine));
};

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

  sprintCmd.command('list').description('list all sprints').action(listSprintsAction);

  sprintCmd
    .command('show [id]')
    .description('print a single sprint as JSON (defaults to the current sprint)')
    .action(showSprintAction);

  sprintCmd
    .command('remove <id>')
    .description('delete a sprint (cascades to its execution + tasks)')
    .option('-y, --yes', 'skip the interactive y/N confirmation')
    .action(removeSprintAction);

  sprintCmd
    .command('activate <id>')
    .description('transition a planned sprint to active (idempotent — already-active passes through)')
    .action(activateSprintAction);

  sprintCmd
    .command('close <id>')
    .description(
      'transition a review sprint to done (rejects any other status); confirms first if any task is still blocked'
    )
    .option('-y, --yes', 'skip the blocked-task confirmation when any task is still blocked')
    .action(closeSprintAction);

  sprintCmd
    .command('reopen <id>')
    .description(
      'reopen a closed sprint back to review so its blocked work is reachable again (idempotent — already-review passes through)'
    )
    .action(reopenSprintAction);

  sprintCmd
    .command('set-current <id>')
    .description(
      "pin a sprint as the user's current selection (read by the TUI on launch and used as the default sprint for CLI commands)"
    )
    .action(setCurrentSprintAction);

  sprintCmd
    .command('progress [id]')
    .description('print task counts, blockers, and the sprint branch (defaults to the current sprint)')
    .action(progressSprintAction);
};

/** One blocked task and, when it's the root cause of a cascade, every task transitively waiting
 *  on it — see {@link groupBlockedTasks}. */
interface BlockedGroup {
  readonly root: BlockedTask;
  readonly waiting: readonly BlockedTask[];
}

/**
 * Group blocked tasks by root cause instead of reporting a cascade as N equal-weight rows. An
 * `own`-blocked task (failed on its own merits) is always a root. An `upstream`-blocked task
 * (the dependency gate parked it because a prerequisite wasn't done — `isUpstreamBlocked`'s same
 * `blockKind` discriminant) walks its `dependsOn` chain to the first ancestor that is NOT itself
 * upstream-blocked; every task that resolves to the same ancestor collapses into that ancestor's
 * `waiting` list. Two edge cases fall back to standing alone with an empty `waiting` list rather
 * than group under something misleading: the chain ends at a task that isn't `blocked` at all
 * (merely `todo` / `in_progress` — nothing is actually wrong yet, it just hasn't run), and a
 * dangling `dependsOn` id or a cycle (neither should happen — `validateTaskGraph` rejects both at
 * plan time — but the walk still caps defensively rather than looping).
 *
 * Pure; needs no new data from the dependency gate — `dependsOn` and `blockKind` are already on
 * every task this command loads.
 */
const groupBlockedTasks = (allTasks: readonly Task[]): readonly BlockedGroup[] => {
  const byId = new Map(allTasks.map((t) => [t.id, t] as const));
  const rootIdOf = (task: BlockedTask): Task['id'] => {
    const seen = new Set<Task['id']>([task.id]);
    let current: Task = task;
    for (;;) {
      if (current.status !== 'blocked') return task.id;
      if (current.blockKind !== 'upstream') return current.id;
      const deps: ReadonlyArray<Task | undefined> = current.dependsOn.map((depId) => byId.get(depId));
      const nextDep = deps.find((d): d is Task => d !== undefined && d.status !== 'done');
      if (nextDep === undefined || seen.has(nextDep.id)) return current.id;
      seen.add(nextDep.id);
      current = nextDep;
    }
  };

  const groups = new Map<Task['id'], BlockedGroup>();
  for (const t of allTasks) {
    if (t.status !== 'blocked') continue;
    const rootId = rootIdOf(t);
    const rootCandidate = byId.get(rootId);
    const root = rootCandidate !== undefined && rootCandidate.status === 'blocked' ? rootCandidate : t;
    const existing = groups.get(rootId);
    if (existing === undefined) groups.set(rootId, { root, waiting: t.id === rootId ? [] : [t] });
    else if (t.id !== rootId) groups.set(rootId, { ...existing, waiting: [...existing.waiting, t] });
  }
  return [...groups.values()];
};

const formatProgress = (sprint: Sprint, tasks: readonly Task[], branchLine: string): string => {
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
    for (const group of groupBlockedTasks(tasks)) {
      const reasonFirstLine = group.root.blockedReason.split('\n')[0] ?? group.root.blockedReason;
      lines.push(`  ✗ ${group.root.name}`);
      lines.push(`      ${reasonFirstLine}`);
      lines.push(`      recover with: ralphctl task unblock ${String(group.root.id)}`);
      if (group.waiting.length > 0) {
        const names = group.waiting.map((t) => t.name).join(', ');
        lines.push(`      ↳ ${String(group.waiting.length)} upstream-blocked task(s) waiting on this: ${names}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};

const formatSprintLine = (s: Sprint): string => {
  const tickets = s.tickets.length;
  return `${String(s.id)}  ${String(s.slug).padEnd(24)}  [${s.status.padEnd(8)}]  ${s.name}  (${String(tickets)} ticket${tickets === 1 ? '' : 's'})`;
};
