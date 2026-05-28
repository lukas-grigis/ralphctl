/**
 * `detect-skills` prompt: one-shot, read-only repo inventory that asks the AI to write two
 * multi-paragraph skills (setup + verify) for the repository. Sibling of `detect-scripts` —
 * scripts produce single shell lines, skills produce stack-aware AI guidance.
 *
 * Under the audit-[09] contract the AI writes `signals.json` directly into the spawn's
 * `outputDir` with `setup-skill-proposal` / `verify-skill-proposal` / `note` signals; the
 * harness validates post-spawn and renders sidecars (`setup-skill.md`, `verify-skill.md`).
 */

import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
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
  /**
   * Audit-[09] output contract section — rendered from the detect-skills `AiOutputContract`
   * by `renderContractSectionFor(detectSkillsOutputContract)`. Instructs the AI to write
   * `signals.json` directly with optional `setup-skill-proposal` / `verify-skill-proposal` /
   * `note` signals.
   */
  readonly outputContractSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const detectSkillsPromptDef: PromptDefinition<DetectSkillsPromptParams> = {
  templateName: 'detect-skills',
  description:
    'Read-only repo inventory that authors two short coding-agent skills: setup (sprint-start prep) and verify (post-task gate interpretation).',
  parameters: {
    repositoryPath: {
      placeholder: 'REPOSITORY_PATH',
      description: 'Absolute path to the repository the AI is inventorying.',
      validate: requireNonEmpty('repositoryPath', 'repository path must not be empty'),
    },
    skillsConvention: {
      placeholder: 'SKILLS_CONVENTION',
      description: 'Provider-specific guidance on where to find existing skills in this repository.',
      validate: requireNonEmpty('skillsConvention', 'skills convention snippet must not be empty'),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the detect-skills contract — instructs the AI to write `signals.json` directly.',
      validate: requireNonEmpty('outputContractSection', 'output-contract section must not be empty'),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['setup-skill-proposal', 'verify-skill-proposal', 'note'],
};

export interface BuildDetectSkillsPromptInput {
  readonly repositoryPath: string;
  readonly skillsConvention: string;
  readonly outputContractSection: string;
}

export const buildDetectSkillsPrompt = async (
  loader: TemplateLoader,
  input: BuildDetectSkillsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, detectSkillsPromptDef, {
    repositoryPath: input.repositoryPath,
    skillsConvention: input.skillsConvention,
    outputContractSection: input.outputContractSection,
  });
