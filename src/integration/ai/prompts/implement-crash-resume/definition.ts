import { type Result } from '@src/domain/result.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered parameters for the implement-crash-resume template.
 *
 * Sent on a RESUMED generator session after the harness was interrupted mid-attempt. The
 * conversation already holds the brief, so this carries only the "reconcile, then finish"
 * instruction plus the output contract for the round's `signals.json`. A vanished session never
 * reaches this prompt cold: the retry loop swaps in the full prompt (`AiSession.coldPrompt`).
 */
export interface ImplementCrashResumePromptParams {
  /** Output contract section for the round's generator output dir — `{{OUTPUT_CONTRACT_SECTION}}`. */
  readonly outputContractSection: string;
}

export const implementCrashResumePromptDef: PromptDefinition<ImplementCrashResumePromptParams> = {
  templateName: 'implement-crash-resume',
  description:
    'Resumed generator turn after the harness was interrupted mid-attempt. Tells the model to reconcile the working tree, then finish the task.',
  parameters: {
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description: "Output contract block for this round's output directory — names the signals.json path.",
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
  },
  // Same accepted union as the full implement prompt — a resumed turn is still a generator turn.
  expectedSignals: [
    'change',
    'decision',
    'learning',
    'note',
    'task-verified',
    'task-complete',
    'task-blocked',
    'commit-message',
  ],
};

export interface BuildImplementCrashResumePromptInput {
  /** Pre-rendered output contract section for this round's generator output dir. */
  readonly outputContractSection: string;
}

/**
 * Render the crash-resume continuation prompt.
 * @public
 */
export const buildImplementCrashResumePrompt = async (
  deps: TemplateLoader,
  input: BuildImplementCrashResumePromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, implementCrashResumePromptDef, { outputContractSection: input.outputContractSection });
