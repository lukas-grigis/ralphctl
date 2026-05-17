import { join } from 'node:path';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { buildUnitLeaf } from '@src/application/flows/_shared/build-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/flows/_shared/render-prompt-to-file.ts';
import { buildIdeatePrompt } from '@src/integration/ai/prompts/ideate/definition.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import type { IdeateDeps } from '@src/application/flows/ideate/deps.ts';
import { ideateAndPlanLeaf } from '@src/application/flows/ideate/leaves/ideate-and-plan.ts';
import { linkSkillsLeaf } from '@src/application/flows/_shared/skills/link-skills.ts';
import { unlinkSkillsLeaf } from '@src/application/flows/_shared/skills/unlink-skills.ts';

export interface CreateIdeateFlowOpts {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly ideaTitle: string;
  readonly ideaText: string;
  /** Working directory for the AI session — typically the repo root the user wants Claude to navigate. */
  readonly cwd: AbsolutePath;
  /** Configured model for ideate. Flows from `config.ai.<provider>.models.ideate`. */
  readonly model: string;
  /** Per-sprint root: `<sprintDir>/ideate/`. Per-run subfolder created at execute time. */
  readonly ideateRoot: AbsolutePath;
  /** Per-run slug — the subfolder under ideateRoot. Defaults to `'session-<timestamp>'`. */
  readonly runSlug?: string;
}

/**
 * Build the ideate chain.
 *
 * Shape:
 *
 *   sequential('ideate', [
 *     load-and-assert-sprint(['draft']),
 *     load-project,
 *     load-tasks,                  // existing tasks; ideate-and-plan appends
 *     build-ideate-unit,           // mkdir <sprintDir>/ideate/<run-slug>/
 *     render-prompt-to-file,       // <unit-root>/prompt.md
 *     ideate-and-plan,             // interactive Claude → reads <unit-root>/ideate.json
 *     save-sprint,
 *     save-tasks,
 *   ])
 *
 * Single-shot per invocation: ideate produces ONE ticket plus its tasks. Re-run for another
 * idea on the same draft sprint.
 */
export const createIdeateFlow = (deps: IdeateDeps, opts: CreateIdeateFlowOpts): Element<IdeateCtx> => {
  const slug = opts.runSlug ?? `session-${String(Date.now())}`;

  return sequential<IdeateCtx>('ideate', [
    loadAndAssertSprintSubChain<IdeateCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    loadProjectLeaf<IdeateCtx>({ projectRepo: deps.projectRepo }),
    loadTasksLeaf<IdeateCtx>({ taskRepo: deps.taskRepo }),
    buildUnitLeaf<IdeateCtx>({
      name: 'build-ideate-unit',
      parent: () => opts.ideateRoot,
      slug: () => slug,
      write: (ctx, root) => {
        const promptPath = AbsolutePath.parse(join(String(root), 'prompt.md'));
        const outputPath = AbsolutePath.parse(join(String(root), 'ideate.json'));
        if (!promptPath.ok) throw promptPath.error;
        if (!outputPath.ok) throw outputPath.error;
        return {
          ...ctx,
          currentUnitRoot: root,
          currentPromptFile: promptPath.value,
          currentOutputFile: outputPath.value,
        };
      },
    }),
    renderPromptToFileLeaf<IdeateCtx>(
      { writeFile: deps.writeFile },
      {
        name: 'render-prompt-to-file',
        path: (ctx) => {
          if (ctx.currentPromptFile === undefined) throw new Error('currentPromptFile missing');
          return ctx.currentPromptFile;
        },
        buildPrompt: (ctx) => {
          if (ctx.project === undefined) throw new Error('project missing');
          if (ctx.currentOutputFile === undefined) throw new Error('currentOutputFile missing');
          return buildIdeatePrompt(deps.templateLoader, {
            ideaTitle: opts.ideaTitle,
            ideaDescription: opts.ideaText,
            project: ctx.project,
            outputFilePath: String(ctx.currentOutputFile),
          });
        },
        write: (ctx, path) => ({ ...ctx, currentPromptFile: path }),
      }
    ),
    linkSkillsLeaf<IdeateCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      {
        flowId: 'ideate',
        cwdPicker: (ctx) => {
          if (ctx.currentUnitRoot === undefined) throw new Error('currentUnitRoot missing');
          return ctx.currentUnitRoot;
        },
      }
    ),
    ideateAndPlanLeaf({
      interactiveAi: deps.interactiveAi,
      runInTerminal: deps.runInTerminal,
      logger: deps.logger,
      model: opts.model,
    }),
    unlinkSkillsLeaf<IdeateCtx>(
      { skillsAdapter: deps.skillsAdapter },
      {
        cwdPicker: (ctx) => {
          if (ctx.currentUnitRoot === undefined) throw new Error('currentUnitRoot missing');
          return ctx.currentUnitRoot;
        },
      }
    ),
    saveSprintLeaf<IdeateCtx>({ sprintRepo: deps.sprintRepo }),
    saveTasksLeaf<IdeateCtx>({ taskRepo: deps.taskRepo }),
  ]);
};
