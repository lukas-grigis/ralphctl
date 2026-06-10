/**
 * `detect-scripts` prompt: one-shot, read-only repo inventory that asks the AI to propose a
 * setup script (sprint-start prep) and a verify script (post-task gate), plus — for monorepo-style
 * repos with separable module roots — structured per-module `verify-gates`. Under the audit-[09]
 * contract, the AI writes `signals.json` directly into the spawn's `outputDir` with
 * `setup-script` / `verify-script` / `verify-gates` / `note` signals — the harness validates
 * post-spawn. `verify-gates` is ADDITIVE: emitted alongside `verify-script`, never instead of it.
 *
 * Sibling of `readiness` — that prompt bundles context-file generation with script proposals;
 * this one strips the context-file half away for callers who already have CLAUDE.md / AGENTS.md
 * in place and only want the scripts.
 */

import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

export interface DetectScriptsPromptParams {
  readonly repositoryPath: string;
  /**
   * Audit-[09] output contract section — rendered from the detect-scripts `AiOutputContract`
   * by `renderContractSectionFor(detectScriptsOutputContract)`. Instructs the AI to write
   * `signals.json` directly with optional `setup-script` / `verify-script` / `verify-gates` /
   * `note` signals.
   */
  readonly outputContractSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const detectScriptsPromptDef: PromptDefinition<DetectScriptsPromptParams> = {
  templateName: 'detect-scripts',
  description: 'Read-only repo inventory that proposes a single-line setup script and a single-line verify script.',
  parameters: {
    repositoryPath: {
      placeholder: 'REPOSITORY_PATH',
      description: 'Absolute path to the repository the AI is inventorying.',
      validate: requireNonEmpty('repositoryPath', 'repository path must not be empty'),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the detect-scripts contract — instructs the AI to write `signals.json` directly.',
      validate: requireNonEmpty('outputContractSection', 'output-contract section must not be empty'),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['setup-script', 'verify-script', 'verify-gates', 'note'],
};

export interface BuildDetectScriptsPromptInput {
  readonly repositoryPath: string;
  readonly outputContractSection: string;
}

export const buildDetectScriptsPrompt = async (
  loader: TemplateLoader,
  input: BuildDetectScriptsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, detectScriptsPromptDef, {
    repositoryPath: input.repositoryPath,
    outputContractSection: input.outputContractSection,
  });
