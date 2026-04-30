/**
 * `createPlanFlow` — chain definition for the plan / replan workflow.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → assert-all-tickets-approved →
 *     load-existing-tasks → plan-tasks → reorder-tasks → save-tasks
 *
 * The use case (`PlanSprintTasksUseCase`) re-checks the same
 * preconditions internally, but the chain still surfaces them as
 * distinct trace entries so a debug session pinpoints which gate failed
 * without diving into the use case code.
 *
 * No skills link/unlink in this chain — planning is implementation-
 * agnostic and runs fast enough that we don't ship a planning skill
 * yet. If/when that changes, wrap `plan-tasks` in `link-skills` /
 * `unlink-skills` per the refine pattern.
 */
import { Result } from 'typescript-result';

import type { Sprint } from '../../../domain/entities/sprint.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import { PlanSprintTasksUseCase } from '../../../business/usecases/plan/plan-sprint-tasks.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import { loadSprintLeaf } from '../leaves/load-sprint.ts';
import { loadTasksLeaf } from '../leaves/load-tasks.ts';
import { reorderTasksLeaf } from '../leaves/reorder-tasks.ts';
import { saveTasksLeaf } from '../leaves/save-tasks.ts';

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
}

export function createPlanFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'logger'>,
  opts: CreatePlanFlowOpts
): Element<PlanCtx> {
  const planUseCase = new PlanSprintTasksUseCase(deps.aiSession, deps.prompts, deps.logger);

  return new Sequential<PlanCtx>('plan', [
    loadSprintLeaf<PlanCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf(),
    assertAllTicketsApprovedLeaf(),
    loadTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }, 'load-existing-tasks'),
    planTasksLeaf(planUseCase, opts.cwd),
    reorderTasksLeaf<PlanCtx>(),
    saveTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
  ]);
}

function planTasksLeaf(useCase: PlanSprintTasksUseCase, cwd: AbsolutePath): Element<PlanCtx> {
  return new Leaf<
    PlanCtx,
    { readonly sprint: Sprint; readonly existingTasks: readonly Task[]; readonly cwd: AbsolutePath },
    readonly Task[]
  >('plan-tasks', {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          existingTasks: input.existingTasks,
          cwd: input.cwd,
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok(result.value.tasks);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('plan-tasks: ctx.sprint must be loaded');
      return { sprint: ctx.sprint, existingTasks: ctx.tasks ?? [], cwd };
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
