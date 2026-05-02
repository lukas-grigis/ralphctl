/**
 * `createPlanFlow` — chain definition for the plan / replan workflow.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → assert-all-tickets-approved →
 *     persist-repo-selection → load-existing-tasks → confirm-replan →
 *     plan-tasks → reorder-tasks → confirm-task-list → save-tasks
 *
 * The use case (`PlanSprintTasksUseCase`) re-checks the same
 * preconditions internally, but the chain still surfaces them as
 * distinct trace entries so a debug session pinpoints which gate failed
 * without diving into the use case code.
 *
 * `persist-repo-selection` runs the repo-pick checkbox UI inside the
 * chain (single-repo projects skip the prompt) and writes the result
 * onto `sprint.affectedRepositories`. Downstream `plan-tasks` then
 * sources `cwd` and `--add-dir` paths directly from the sprint.
 *
 * No skills link/unlink in this chain — planning reads code rather
 * than writing it, so the bundled skills add nothing. The bracket
 * stays on `executeFlow` where it earns its keep.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Project } from '@src/domain/entities/project.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { PlanSprintTasksUseCase } from '@src/business/usecases/plan/plan-sprint-tasks.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { loadTasksLeaf } from '@src/application/chains/leaves/load-tasks.ts';
import { reorderTasksLeaf } from '@src/application/chains/leaves/reorder-tasks.ts';
import { saveTasksLeaf } from '@src/application/chains/leaves/save-tasks.ts';

export interface PlanCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly sprint?: Sprint;
  /** Pre-existing tasks loaded by `load-existing-tasks`; replaced by `plan-tasks`. */
  readonly tasks?: readonly Task[];
}

export interface CreatePlanFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /**
   * When true, run Claude with stdio: 'inherit' and read tasks JSON
   * from `outputFilePath`. Defaults to false (headless / stdout parse).
   */
  readonly interactive?: boolean;
  /** Required when `interactive` is true — see PlanSprintTasksInput. */
  readonly outputFilePath?: string;
  /** Required when `interactive` is true — Ink-pause + spawn handover. */
  readonly runInTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createPlanFlow(
  deps: Pick<
    ChainSharedDeps,
    'sprintRepo' | 'projectRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'logger' | 'prompt'
  >,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  const planUseCase = new PlanSprintTasksUseCase(deps.aiSession, deps.prompts, deps.logger);

  return new Sequential<PlanCtx>('plan', [
    loadSprintLeaf<PlanCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf(),
    assertAllTicketsApprovedLeaf(),
    persistRepoSelectionLeaf(deps),
    loadTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }, 'load-existing-tasks'),
    confirmReplanLeaf(deps, opts),
    planTasksLeaf(planUseCase, opts),
    reorderTasksLeaf<PlanCtx>(),
    confirmTaskListLeaf(deps, opts),
    saveTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
  ]);
}

/**
 * Pre-plan replan gate: when `ctx.tasks` is non-empty (a prior plan
 * exists for this sprint) and we're in interactive mode, ask the user
 * whether they really want to replace the existing tasks. Headless / CI
 * proceeds silently — that's the contract for an `--auto` run.
 */
function confirmReplanLeaf(
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly existingTasks: readonly Task[]; readonly interactive: boolean }, void>(
    'confirm-replan',
    {
      useCase: {
        async execute(input) {
          if (!input.interactive || input.existingTasks.length === 0) {
            return Result.ok(undefined);
          }
          const proceed = await deps.prompt.confirm({
            message: `${String(input.existingTasks.length)} task(s) already exist for this sprint. Re-planning will replace them all. Continue?`,
            default: true,
          });
          if (!proceed) {
            deps.logger.info('plan: user cancelled replan');
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'replan-cancelled',
                attemptedAction: 'plan',
                message: 'replan cancelled by user',
              })
            );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({
        existingTasks: ctx.tasks ?? [],
        interactive: opts.interactive === true,
      }),
      output: (ctx) => ctx,
    }
  );
}

/**
 * Post-plan acceptance gate: shows the parsed task list and asks the
 * user to confirm before save-tasks persists. Decline → return an
 * `InvalidStateError` so the chain ends in `failed` and save-tasks
 * never runs (atomic — nothing gets written if the user said no).
 * Headless skips silently.
 */
function confirmTaskListLeaf(
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly tasks: readonly Task[]; readonly interactive: boolean }, void>(
    'confirm-task-list',
    {
      useCase: {
        async execute(input) {
          if (!input.interactive || input.tasks.length === 0) {
            return Result.ok(undefined);
          }
          const summary = renderTaskListSummary(input.tasks);
          const accept = await deps.prompt.confirm({
            message: `Approve the planned tasks and save?`,
            details: summary,
            default: true,
          });
          if (!accept) {
            deps.logger.info('plan: user rejected task list');
            return Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'task-list-rejected',
                attemptedAction: 'plan',
                message: 'planned tasks rejected by user — nothing saved',
              })
            );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => ({
        tasks: ctx.tasks ?? [],
        interactive: opts.interactive === true,
      }),
      output: (ctx) => ctx,
    }
  );
}

/** Compact list rendering for the post-plan confirm prompt. */
function renderTaskListSummary(tasks: readonly Task[]): string {
  const lines: string[] = [];
  lines.push(`${String(tasks.length)} task(s) planned:`);
  for (const t of tasks) {
    const blocks = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.map(String).join(', ')})` : '';
    lines.push(`  ${String(t.order)}. ${t.name}${blocks}`);
    lines.push(`     ${String(t.projectPath)}`);
  }
  return lines.join('\n');
}

function planTasksLeaf(useCase: PlanSprintTasksUseCase, opts: CreatePlanFlowOpts): Element<PlanCtx> {
  return new Leaf<
    PlanCtx,
    {
      readonly sprint: Sprint;
      readonly existingTasks: readonly Task[];
      readonly cwd: AbsolutePath;
      readonly additionalRepoPaths: readonly AbsolutePath[];
    },
    readonly Task[]
  >('plan-tasks', {
    useCase: {
      async execute(input) {
        // Claude's Write tool can't create intermediate directories,
        // and the harness's `readFile` returns ENOENT if the parent
        // doesn't exist. Pre-create the planning dir before the AI
        // session starts.
        if (opts.outputFilePath !== undefined && opts.outputFilePath !== '') {
          await mkdir(dirname(opts.outputFilePath), { recursive: true });
        }

        const result = await useCase.execute({
          sprint: input.sprint,
          existingTasks: input.existingTasks,
          cwd: input.cwd,
          ...(opts.interactive === true ? { interactive: true } : {}),
          ...(opts.outputFilePath !== undefined ? { outputFilePath: opts.outputFilePath } : {}),
          ...(opts.runInTerminal !== undefined ? { runInTerminal: opts.runInTerminal } : {}),
          ...(input.additionalRepoPaths.length > 0 ? { additionalRepoPaths: input.additionalRepoPaths } : {}),
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value.tasks);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('plan-tasks: ctx.sprint must be loaded');
      // First repo on the sprint becomes the canonical cwd; the rest
      // become `--add-dir` flags. `persist-repo-selection` guarantees
      // there is at least one entry; if it's empty (legacy / migrated
      // sprint with no plan yet) fall back to the chain's launch cwd.
      const repos = ctx.sprint.affectedRepositories;
      const cwd = repos[0] ?? opts.cwd;
      const additionalRepoPaths = repos.slice(1);
      return { sprint: ctx.sprint, existingTasks: ctx.tasks ?? [], cwd, additionalRepoPaths };
    },
    output: (ctx, tasks) => ({ ...ctx, tasks }),
  });
}

function assertDraftLeaf(): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprint: Sprint }, void>('assert-draft', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'draft') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction: 'plan',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('assert-draft: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}

/**
 * `persist-repo-selection` — load the sprint's project, pick which of its
 * repos this sprint touches, and persist the selection on the sprint
 * aggregate. Single-repo projects skip the prompt entirely; multi-repo
 * projects render a checkbox UI with all repos pre-selected by default.
 *
 * The leaf reads `ctx.sprint` (loaded above), looks up the project via
 * `projectRepo.findByName(sprint.projectName)`, calls
 * `sprint.setAffectedRepositories(...)`, and writes the updated sprint
 * back through `sprintRepo.save`. The mutated sprint is also threaded
 * onto `ctx.sprint` so downstream leaves (`plan-tasks`) see the new
 * `affectedRepositories` without re-loading.
 */
function persistRepoSelectionLeaf(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'projectRepo' | 'prompt' | 'logger'>
): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprint: Sprint }, Sprint>('persist-repo-selection', {
    useCase: {
      async execute(input): Promise<Result<Sprint, DomainError>> {
        const projectResult = await deps.projectRepo.findByName(input.sprint.projectName);
        if (!projectResult.ok) return Result.error(projectResult.error);
        const project = projectResult.value;

        const selected = await pickAffectedRepos(project, input.sprint, deps);
        if (!selected.ok) return Result.error(selected.error);

        const updated = input.sprint.setAffectedRepositories(selected.value);
        if (!updated.ok) return Result.error(updated.error);

        const saved = await deps.sprintRepo.save(updated.value);
        if (!saved.ok) return Result.error(saved.error);

        return Result.ok(updated.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('persist-repo-selection: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
}

/**
 * Pick repos for the sprint. Single-repo projects skip the prompt
 * (the choice is forced); multi-repo projects render a checkbox with
 * the previous selection (if any) pre-checked, falling back to ALL
 * repos by default.
 */
async function pickAffectedRepos(
  project: Project,
  sprint: Sprint,
  deps: Pick<ChainSharedDeps, 'prompt' | 'logger'>
): Promise<Result<readonly AbsolutePath[], InvalidStateError>> {
  if (project.repositories.length === 0) {
    return Result.error(
      new InvalidStateError({
        entity: 'project',
        currentState: 'no-repositories',
        attemptedAction: 'plan',
        message: `project '${String(project.name)}' has no repositories — cannot plan`,
      })
    );
  }

  if (project.repositories.length === 1) {
    const only = project.repositories[0];
    if (only === undefined) throw new Error('unreachable: length-check above');
    return Result.ok([only.path]);
  }

  const previousSelection = new Set(sprint.affectedRepositories.map((p) => String(p)));
  const choices = project.repositories.map((r) => ({
    label: `${r.name} — ${String(r.path)}`,
    value: String(r.path),
  }));
  const defaults = project.repositories
    .map((r) => String(r.path))
    .filter((p) => previousSelection.size === 0 || previousSelection.has(p));

  const selectedStrings = await deps.prompt.checkbox<string>({
    message: 'Select repositories to include in this planning session',
    choices,
    defaults,
  });

  if (selectedStrings.length === 0) {
    deps.logger.info('plan: user selected no repositories');
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'no-repos-selected',
        attemptedAction: 'plan',
        message: 'at least one repository must be selected to plan',
      })
    );
  }

  const parsed: AbsolutePath[] = [];
  for (const s of selectedStrings) {
    const known = project.repositories.find((r) => String(r.path) === s);
    if (known === undefined) {
      return Result.error(
        new InvalidStateError({
          entity: 'project',
          currentState: 'unknown-repo-path',
          attemptedAction: 'plan',
          message: `selected repo '${s}' not found on project '${String(project.name)}'`,
        })
      );
    }
    parsed.push(known.path);
  }

  return Result.ok(parsed);
}

function assertAllTicketsApprovedLeaf(): Element<PlanCtx> {
  return new Leaf<PlanCtx, { readonly sprint: Sprint }, void>('assert-all-tickets-approved', {
    useCase: {
      async execute(input) {
        if (input.sprint.tickets.length === 0 || !input.sprint.hasApprovedAllTickets()) {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: 'tickets-not-approved',
                attemptedAction: 'plan',
                message: 'plan requires every ticket to be approved (run sprint refine first)',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('assert-all-tickets-approved: ctx.sprint must be loaded first');
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
