/**
 * `detect-scripts` prompt: one-shot, read-only repo inventory that asks the AI to propose a
 * setup script (sprint-start prep) and a verify script (post-task gate). Reuses the existing
 * `<setup-script>` and `<verify-script>` signal tags so the parser registry already understands
 * the response.
 *
 * Sibling of `readiness` — that prompt bundles context-file generation with script proposals;
 * this one strips the context-file half away for callers who already have CLAUDE.md / AGENTS.md
 * in place and only want the scripts.
 */

import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

export interface DetectScriptsPromptParams {
  readonly repositoryPath: string;
}

export const detectScriptsPromptDef: PromptDefinition<DetectScriptsPromptParams> = {
  templateName: 'detect-scripts',
  description: 'Read-only repo inventory that proposes a single-line setup script and a single-line verify script.',
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
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['setup-script', 'verify-script', 'note'],
};

export interface BuildDetectScriptsPromptInput {
  readonly repositoryPath: string;
}

export const buildDetectScriptsPrompt = async (
  loader: TemplateLoader,
  input: BuildDetectScriptsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, detectScriptsPromptDef, { repositoryPath: input.repositoryPath });
