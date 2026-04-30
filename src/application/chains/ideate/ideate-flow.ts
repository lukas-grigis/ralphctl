/**
 * `createIdeateFlow` — chain definition for the quick-path "ideate +
 * plan" workflow that combines refinement and task generation in a
 * single AI session.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → load-project →
 *     ideate-and-plan → save-results (Sequential: save-sprint + save-tasks)
 *
 * The save-results sub-Sequential keeps the two persistence writes
 * adjacent in the trace so a debug session sees them as a unit. Each
 * is its own leaf so a failure shows precisely which one broke.
 */
import { Result } from 'typescript-result';

import type { Sprint } from '../../../domain/entities/sprint.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import type { Project } from '../../../domain/entities/project.ts';
import type { Task } from '../../../domain/entities/task.ts';
import { IdeateAndPlanUseCase } from '../../../business/usecases/ideate/ideate-and-plan.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { Element } from '../../../kernel/chain/element.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import { Sequential } from '../../../kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '../chain-deps.ts';
import { loadSprintLeaf } from '../leaves/load-sprint.ts';
import { saveSprintLeaf } from '../leaves/save-sprint.ts';
import { saveTasksLeaf } from '../leaves/save-tasks.ts';

export interface IdeateCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly projectName: ProjectName;
  readonly ideaText: string;
  readonly sprint?: Sprint;
  readonly project?: Project;
  readonly tasks?: readonly Task[];
}

export interface CreateIdeateFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly projectName: ProjectName;
  readonly ideaText: string;
}

export function createIdeateFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'projectRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'logger'>,
  _opts: CreateIdeateFlowOpts
): Element<IdeateCtx> {
  void _opts;
  const ideateUseCase = new IdeateAndPlanUseCase(deps.aiSession, deps.prompts, deps.logger);

  return new Sequential<IdeateCtx>('ideate', [
    loadSprintLeaf<IdeateCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf(),
    loadProjectLeaf(deps),
    ideateAndPlanLeaf(ideateUseCase),
    new Sequential<IdeateCtx>('save-results', [
      saveSprintLeaf<IdeateCtx>({ sprintRepo: deps.sprintRepo }),
      saveTasksLeaf<IdeateCtx>({ taskRepo: deps.taskRepo }),
    ]),
  ]);
}

function loadProjectLeaf(deps: Pick<ChainSharedDeps, 'projectRepo'>): Element<IdeateCtx> {
  return new Leaf<IdeateCtx, { readonly name: ProjectName }, Project>('load-project', {
    useCase: {
      async execute(input) {
        return deps.projectRepo.findByName(input.name);
      },
    },
    input: (ctx) => ({ name: ctx.projectName }),
    output: (ctx, project) => ({ ...ctx, project }),
  });
}

function ideateAndPlanLeaf(useCase: IdeateAndPlanUseCase): Element<IdeateCtx> {
  return new Leaf<
    IdeateCtx,
    {
      readonly sprint: Sprint;
      readonly project: Project;
      readonly cwd: AbsolutePath;
      readonly ideaText: string;
    },
    { readonly sprint: Sprint; readonly tasks: readonly Task[] }
  >('ideate-and-plan', {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          project: input.project,
          cwd: input.cwd,
          ideaText: input.ideaText,
        });
        if (!result.ok) return Result.error(result.error);
        const withTicket = input.sprint.addTicket(result.value.ticket);
        if (!withTicket.ok) return Result.error(withTicket.error);
        return Result.ok({ sprint: withTicket.value, tasks: result.value.tasks });
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('ideate-and-plan: ctx.sprint must be loaded');
      if (!ctx.project) throw new Error('ideate-and-plan: ctx.project must be loaded');
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        cwd: ctx.cwd,
        ideaText: ctx.ideaText,
      };
    },
    output: (ctx, out) => ({ ...ctx, sprint: out.sprint, tasks: out.tasks }),
  });
}

function assertDraftLeaf(): Element<IdeateCtx> {
  return new Leaf<IdeateCtx, { readonly sprint: Sprint }, void>('assert-draft', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'draft') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction: 'ideate',
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
