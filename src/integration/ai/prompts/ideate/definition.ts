import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
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
  readonly outputFilePath: string;
  readonly schema: string;
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
    outputFilePath: {
      placeholder: 'OUTPUT_FILE',
      description: 'Absolute path the AI must write its JSON answer to.',
      validate: nonEmpty('outputFilePath'),
    },
    schema: {
      placeholder: 'SCHEMA',
      description: 'JSON Schema the tasks array conforms to.',
      validate: nonEmpty('schema'),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: [],
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
    readonly outputFilePath: string;
  }
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, ideatePromptDef, {
    ideaTitle: input.ideaTitle,
    ideaDescription: input.ideaDescription,
    projectName: project_name(input.project),
    repositories: renderRepositories(input.project),
    outputFilePath: input.outputFilePath,
    schema: TASK_IMPORT_JSON_SCHEMA,
  });

const project_name = (project: Project): string => project.displayName;
