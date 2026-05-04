/**
 * `createIdeateFlow` — chain definition for the quick-path "ideate +
 * plan" workflow that combines refinement and task generation in a
 * single AI session.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → load-project →
 *     render-prompt-to-file → ideate-and-plan → save-results
 *     (Sequential: save-sprint + save-tasks)
 *
 * `render-prompt-to-file` writes the FULL ideate prompt (idea text,
 * project, repos, harness context, signal vocabulary, schema) to
 * `<sprintDir>/contexts/ideate.md`. The downstream `ideate-and-plan`
 * leaf hands the AI a thin wrapper pointing at that file.
 *
 * The save-results sub-Sequential keeps the two persistence writes
 * adjacent in the trace so a debug session sees them as a unit. Each
 * is its own leaf so a failure shows precisely which one broke.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Project } from '@src/domain/entities/project.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { IdeateAndPlanUseCase } from '@src/business/usecases/ideate/ideate-and-plan.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AbsolutePath as AbsolutePathVO } from '@src/domain/values/absolute-path.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertDraftLeaf } from '@src/application/chains/leaves/assert-draft.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { saveSprintLeaf } from '@src/application/chains/leaves/save-sprint.ts';
import { saveTasksLeaf } from '@src/application/chains/leaves/save-tasks.ts';

export interface IdeateCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly projectName: ProjectName;
  readonly ideaText: string;
  readonly sprint?: Sprint;
  readonly project?: Project;
  readonly tasks?: readonly Task[];
  /**
   * Resolved ideate prompt file path. Set by `render-prompt-to-file`;
   * consumed by `ideate-and-plan`.
   */
  readonly promptFilePath?: AbsolutePathVO;
}

export function createIdeateFlow(
  deps: Pick<
    ChainSharedDeps,
    'sprintRepo' | 'projectRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'logger' | 'writeContextFile'
  >
): Element<IdeateCtx> {
  const ideateUseCase = new IdeateAndPlanUseCase(deps.aiSession, deps.logger);

  const renderPromptStep = renderPromptToFileLeaf<IdeateCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'ideate',
      identifier: () => '',
      buildPrompt: (ctx) => {
        if (!ctx.sprint) {
          throw new Error('render-prompt-to-file: ctx.sprint must be loaded first');
        }
        return deps.prompts.buildIdeatePrompt({
          sprint: ctx.sprint,
          ideaText: ctx.ideaText,
        });
      },
    }
  );

  return new Sequential<IdeateCtx>('ideate', [
    loadSprintLeaf<IdeateCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf<IdeateCtx>('ideate'),
    loadProjectLeaf(deps),
    renderPromptStep,
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
      readonly promptFilePath: AbsolutePathVO;
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
          promptFilePath: String(input.promptFilePath),
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
      if (!ctx.promptFilePath) {
        throw new Error('ideate-and-plan: ctx.promptFilePath must be set by render-prompt-to-file');
      }
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        cwd: ctx.cwd,
        ideaText: ctx.ideaText,
        promptFilePath: ctx.promptFilePath,
      };
    },
    output: (ctx, out) => ({ ...ctx, sprint: out.sprint, tasks: out.tasks }),
  });
}
