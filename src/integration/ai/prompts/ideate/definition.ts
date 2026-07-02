import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import { renderPriorLearningsSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { TASK_IMPORT_JSON_SCHEMA } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

/**
 * Pre-rendered string parameters for the ideate template. The flow combines refine + plan
 * in a single interactive AI session; the AI is told to write a JSON object containing
 * `requirements` (markdown) and `tasks` (array) to `{{OUTPUT_FILE}}`.
 */
export interface IdeatePromptParams {
  readonly ideaTitle: string;
  readonly ideaDescription: string;
  readonly projectName: string;
  /** Markdown bulleted list of repository paths the user pre-selected for this sprint. */
  readonly repositories: string;
  readonly schema: string;
  /**
   * Audit-[09] output contract section — rendered from the ideate `AiOutputContract` by
   * `renderContractSectionFor(ideateOutputContract)`. Tells the AI to write `signals.json`
   * directly with one `ideated-tickets` signal whose `outputJson` carries the combined
   * refine + plan envelope.
   */
  readonly outputContractSection: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress on this sprint`
   * section (audit-[07]). Empty when the journal has no entries yet.
   */
  readonly priorProgress: string;
  /**
   * Markdown body for the `<prior_learnings>` block — this project's not-yet-promoted ledger
   * insights (both `learning` and `decision` rows), composed application-side by
   * `composePriorLearnings` and rendered by `renderPriorLearningsSection`. Read-only background so
   * the combined refine + plan session scopes tasks and picks verification commands against earned
   * repo facts rather than blind. Empty string when the ledger is absent / empty so the surrounding
   * template prose handles the empty case without a per-flow branch.
   */
  readonly priorLearningsSection: string;
}

const nonEmpty =
  (field: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0
      ? Result.error(new ValidationError({ field, value: v, message: `${field} must not be empty` }))
      : Result.ok(v);

export const ideatePromptDef: PromptDefinition<IdeatePromptParams> = {
  templateName: 'ideate',
  description:
    'Combined interactive refine + plan for one free-text idea. Two phases in one session; output is a JSON object with `requirements` and `tasks`.',
  parameters: {
    ideaTitle: { placeholder: 'IDEA_TITLE', description: 'Short title for the idea.', validate: nonEmpty('ideaTitle') },
    ideaDescription: {
      placeholder: 'IDEA_DESCRIPTION',
      description: 'Free-text idea body the AI refines.',
      validate: nonEmpty('ideaDescription'),
    },
    projectName: {
      placeholder: 'PROJECT_NAME',
      description: 'Project name (for the AI to reference in the rendered context).',
      validate: nonEmpty('projectName'),
    },
    repositories: {
      placeholder: 'REPOSITORIES',
      description: 'Markdown-rendered list of repository paths for the AI to explore.',
      validate: nonEmpty('repositories'),
    },
    schema: {
      placeholder: 'SCHEMA',
      description: 'JSON Schema the tasks array conforms to.',
      validate: nonEmpty('schema'),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the ideate contract — instructs the AI to write `signals.json` directly with one `ideated-tickets` signal.',
      validate: nonEmpty('outputContractSection'),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description: 'Current `progress.md` body — empty when the sprint journal has no entries yet.',
    },
    priorLearningsSection: {
      placeholder: 'PRIOR_LEARNINGS',
      description:
        "`<prior_learnings>` block — this project's not-yet-promoted ledger insights (learnings + decisions); empty when none recorded yet.",
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    VALIDATION_CHECKLIST: 'validation-checklist',
  },
  expectedSignals: ['ideated-tickets', 'note', 'learning', 'decision'],
};

export const renderRepositories = (project: Project): string => {
  if (project.repositories.length === 0) return '_no repositories configured_';
  return project.repositories.map((r) => `- \`${String(r.path)}\` (${r.name})`).join('\n');
};

export const buildIdeatePrompt = async (
  deps: TemplateLoader,
  input: {
    readonly ideaTitle: string;
    readonly ideaDescription: string;
    readonly project: Project;
    readonly outputContractSection: string;
    /** Current `progress.md` body — inlined into the prompt's "## Prior progress" section. */
    readonly priorProgress: string;
    /**
     * Pre-composed prior-sprint learnings body (bullet list built by `composePriorLearnings`).
     * Absent or empty → the `{{PRIOR_LEARNINGS}}` placeholder collapses cleanly. Composed
     * application-side by the ideate flow from this project's ledger; passed in by the render leaf.
     */
    readonly priorLearnings?: string;
  }
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, ideatePromptDef, {
    ideaTitle: input.ideaTitle,
    ideaDescription: input.ideaDescription,
    projectName: project_name(input.project),
    repositories: renderRepositories(input.project),
    schema: TASK_IMPORT_JSON_SCHEMA,
    outputContractSection: input.outputContractSection,
    priorProgress: input.priorProgress,
    priorLearningsSection: renderPriorLearningsSection(input.priorLearnings),
  });

const project_name = (project: Project): string => project.displayName;
