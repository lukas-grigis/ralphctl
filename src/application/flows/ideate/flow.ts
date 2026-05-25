import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
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
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { ideateOutputContract } from '@src/application/flows/ideate/leaves/ideate.contract.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import type { IdeateDeps } from '@src/application/flows/ideate/deps.ts';
import { ideateAndPlanLeaf } from '@src/application/flows/ideate/leaves/ideate-and-plan.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';
import { stampSessionMetaLeaf } from '@src/application/flows/_shared/stamp-session-meta.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

export interface CreateIdeateFlowOpts {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly ideaTitle: string;
  readonly ideaText: string;
  /** Working directory for the AI session — typically the repo root the user wants Claude to navigate. */
  readonly cwd: AbsolutePath;
  /** Provider id used to attribute the per-run spawn in its `meta.json` sidecar. */
  readonly providerId: string;
  /** Configured model for ideate. Flows from `settings.ai.ideate.model`. */
  readonly model: string;
  /** Resolved effort / reasoning level for the ideate chain — optional. */
  readonly effort?: string;
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
/**
 * Read `<sprintDir>/progress.md` for the inline `## Prior progress` section (audit-[07]).
 * Ideate runs under `<sprintDir>/ideate/<run-slug>/`, so the sprint dir is the parent of the
 * supplied ideate root. Best-effort: missing or unreadable degrades to empty string.
 */
const readSprintProgress = async (ideateRoot: AbsolutePath): Promise<string> => {
  const sprintDir = dirname(String(ideateRoot));
  try {
    return await fs.readFile(join(sprintDir, 'progress.md'), 'utf8');
  } catch {
    return '';
  }
};

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
        // audit-[09]: the AI writes `signals.json` directly under the unit root; the leaf
        // validates that file via the ideate contract.
        const outputPath = AbsolutePath.parse(join(String(root), 'signals.json'));
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
        buildPrompt: async (ctx) => {
          if (ctx.project === undefined) throw new Error('project missing');
          if (ctx.currentUnitRoot === undefined) throw new Error('currentUnitRoot missing');
          const priorProgress = await readSprintProgress(opts.ideateRoot);
          return buildIdeatePrompt(deps.templateLoader, {
            ideaTitle: opts.ideaTitle,
            ideaDescription: opts.ideaText,
            project: ctx.project,
            outputContractSection: renderContractSectionFor(ideateOutputContract, ctx.currentUnitRoot),
            priorProgress,
          });
        },
        write: (ctx, path) => ({ ...ctx, currentPromptFile: path }),
      }
    ),
    installSkillsLeaf<IdeateCtx>(
      { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
      {
        flowId: 'ideate',
        // Skills land in the AI session's cwd (the repo) — the provider-native conventions
        // only auto-discover skills from cwd, not from `--add-dir` roots.
        cwdPicker: () => opts.cwd,
      }
    ),
    stampSessionMetaLeaf<IdeateCtx>(
      { writeFile: deps.writeFile, clock: deps.clock },
      {
        name: 'stamp-meta-ideate',
        resolve: (ctx) => {
          if (ctx.currentUnitRoot === undefined) {
            throw new InvalidStateError({
              entity: 'chain',
              currentState: 'pre-stamp-meta',
              attemptedAction: 'stamp-meta-ideate',
              message: 'stamp-meta-ideate: currentUnitRoot missing — build-ideate-unit must run first',
            });
          }
          return {
            outputDir: ctx.currentUnitRoot,
            flow: 'ideate',
            provider: opts.providerId,
            model: opts.model,
            effort: opts.effort ?? null,
          };
        },
      }
    ),
    ideateAndPlanLeaf({
      interactiveAi: deps.interactiveAi,
      runInTerminal: deps.runInTerminal,
      logger: deps.logger,
      writeFile: deps.writeFile,
      eventBus: deps.eventBus,
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    }),
    uninstallSkillsLeaf<IdeateCtx>({ skillsAdapter: deps.skillsAdapter }, { cwdPicker: () => opts.cwd }),
    saveSprintLeaf<IdeateCtx>({ sprintRepo: deps.sprintRepo }),
    saveTasksLeaf<IdeateCtx>({ taskRepo: deps.taskRepo }),
  ]);
};
