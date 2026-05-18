import { join } from 'node:path';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';
import { loadSprintExecutionLeaf } from '@src/application/flows/_shared/sprint/load-execution.ts';
import { loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';
import { buildUnitLeaf } from '@src/application/flows/_shared/build-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/flows/_shared/render-prompt-to-file.ts';
import { buildPlanPrompt } from '@src/integration/ai/prompts/plan/definition.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';
import type { PlanDeps } from '@src/application/flows/plan/deps.ts';
import { callPlannerInteractiveLeaf } from '@src/application/flows/plan/leaves/call-planner-interactive.ts';
import { linkSkillsLeaf } from '@src/application/flows/_shared/skills/link-skills.ts';
import { unlinkSkillsLeaf } from '@src/application/flows/_shared/skills/unlink-skills.ts';

export interface CreatePlanFlowOpts {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  /** Working directory for the AI session — typically the repo root for codebase navigation. */
  readonly cwd: AbsolutePath;
  /**
   * Extra repo roots to mount alongside `cwd` so the planner can read across every repo on a
   * multi-repo project without per-file approval prompts. Caller (the launcher) passes
   * `project.repositories.map((r) => r.path)`; the adapter folds duplicates with `cwd`.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  /** Configured model — `config.ai.<provider>.models.plan`. */
  readonly model: string;
  /** Per-sprint root: `<sprintDir>/plan/`. Per-run subfolder created at execute time. */
  readonly planRoot: AbsolutePath;
  /** Optional run slug. Defaults to `'session-<timestamp>'`. */
  readonly runSlug?: string;
}

/**
 * Build the plan chain. Plan is **always interactive** — the user is in the loop for
 * implementation decisions; the AI writes a JSON task array to disk and the harness reads
 * it back.
 *
 *   sequential('plan', [
 *     load-and-assert-sprint(['draft']),
 *     load-project,
 *     load-sprint-execution,
 *     load-tasks,                       // existing tasks (replan support)
 *     build-plan-unit,                  // mkdir <sprintDir>/plan/<run-slug>/
 *     render-prompt-to-file,            // <unit-root>/prompt.md
 *     call-planner-interactive,         // hand TTY → reads <unit-root>/plan.json → builds Tasks → planSprint(draft → planned)
 *     save-tasks,
 *     save-sprint,                      // sprint.status = 'planned'
 *   ])
 *
 * Persistence order: tasks first, then sprint. The sprint's `planned` status is the harness's
 * "tasks are ready" signal — saving it last means a crash mid-save leaves the sprint as
 * `draft` even if the tasks already landed; the next plan run is idempotent.
 */
export const createPlanFlow = (deps: PlanDeps, opts: CreatePlanFlowOpts): Element<PlanCtx> => {
  const slug = opts.runSlug ?? `session-${String(Date.now())}`;

  return sequential<PlanCtx>('plan', [
    loadAndAssertSprintSubChain<PlanCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    loadProjectLeaf<PlanCtx>({ projectRepo: deps.projectRepo }),
    loadSprintExecutionLeaf<PlanCtx>({ sprintExecutionRepo: deps.sprintExecutionRepo }),
    loadTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
    buildUnitLeaf<PlanCtx>({
      name: 'build-plan-unit',
      parent: () => opts.planRoot,
      slug: () => slug,
      write: (ctx, root) => {
        const promptPath = AbsolutePath.parse(join(String(root), 'prompt.md'));
        const outputPath = AbsolutePath.parse(join(String(root), 'plan.json'));
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
    renderPromptToFileLeaf<PlanCtx>(
      { writeFile: deps.writeFile },
      {
        name: 'render-prompt-to-file',
        path: (ctx) => {
          if (ctx.currentPromptFile === undefined) throw new Error('currentPromptFile missing');
          return ctx.currentPromptFile;
        },
        buildPrompt: (ctx) => {
          if (ctx.sprint === undefined) throw new Error('sprint missing');
          if (ctx.project === undefined) throw new Error('project missing');
          if (ctx.currentOutputFile === undefined) throw new Error('currentOutputFile missing');
          return buildPlanPrompt(deps.templateLoader, {
            sprint: ctx.sprint,
            project: ctx.project,
            outputFilePath: String(ctx.currentOutputFile),
            ...(ctx.tasks !== undefined && ctx.tasks.length > 0 ? { existingTasks: ctx.tasks } : {}),
          });
        },
        write: (ctx, path) => ({ ...ctx, currentPromptFile: path }),
      }
    ),
    linkSkillsLeaf<PlanCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      {
        flowId: 'plan',
        // Skills land in the AI session's cwd (the repo) — the provider-native conventions
        // only auto-discover skills from cwd, not from `--add-dir` roots.
        cwdPicker: () => opts.cwd,
      }
    ),
    callPlannerInteractiveLeaf({
      interactiveAi: deps.interactiveAi,
      runInTerminal: deps.runInTerminal,
      logger: deps.logger,
      clock: deps.clock,
      cwd: opts.cwd,
      model: opts.model,
      ...(opts.additionalRoots !== undefined && opts.additionalRoots.length > 0
        ? { additionalRoots: opts.additionalRoots }
        : {}),
      ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
    }),
    unlinkSkillsLeaf<PlanCtx>({ skillsAdapter: deps.skillsAdapter }, { cwdPicker: () => opts.cwd }),
    saveTasksLeaf<PlanCtx>({ taskRepo: deps.taskRepo }),
    saveSprintLeaf<PlanCtx>({ sprintRepo: deps.sprintRepo }),
  ]);
};
