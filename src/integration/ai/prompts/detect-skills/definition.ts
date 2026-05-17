/**
 * `detect-skills` prompt: one-shot, read-only repo inventory that asks the AI to write two
 * multi-paragraph skills (setup + verify) for the repository. Sibling of `detect-scripts` —
 * scripts produce single shell lines, skills produce stack-aware AI guidance.
 */

import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

export interface DetectSkillsPromptParams {
  readonly repositoryPath: string;
  /**
   * Markdown snippet describing where this AI tool stores skills (e.g. `.claude/skills/<id>/SKILL.md`),
   * or a single sentence stating the provider has no convention. Sourced from the
   * `SkillsAdapter` so the prompt template never names a specific tool. Used by the AI
   * session to look up existing skills and avoid duplicating their purpose.
   */
  readonly skillsConvention: string;
}

export const detectSkillsPromptDef: PromptDefinition<DetectSkillsPromptParams> = {
  templateName: 'detect-skills',
  description:
    'Read-only repo inventory that authors two short coding-agent skills: setup (sprint-start prep) and verify (post-task gate interpretation).',
  parameters: {
    repositoryPath: {
      placeholder: 'REPOSITORY_PATH',
      description: 'Absolute path to the repository the AI is inventorying.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({
                field: 'repositoryPath',
                value: v,
                message: 'repository path must not be empty',
              })
            )
          : Result.ok(v),
    },
    skillsConvention: {
      placeholder: 'SKILLS_CONVENTION',
      description: 'Provider-specific guidance on where to find existing skills in this repository.',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(
              new ValidationError({
                field: 'skillsConvention',
                value: v,
                message: 'skills convention snippet must not be empty',
              })
            )
          : Result.ok(v),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  // Skills are extracted by the propose leaf via direct tag parsing — not via the harness
  // signal registry (which deals with strongly-typed runtime signals like `progress`,
  // `task-verified`, etc.). Setup/verify skills are inert markdown bodies, so we list no
  // expected signals here.
  expectedSignals: [],
};

export interface BuildDetectSkillsPromptInput {
  readonly repositoryPath: string;
  readonly skillsConvention: string;
}

export const buildDetectSkillsPrompt = async (
  loader: TemplateLoader,
  input: BuildDetectSkillsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, detectSkillsPromptDef, {
    repositoryPath: input.repositoryPath,
    skillsConvention: input.skillsConvention,
  });
