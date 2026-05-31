/**
 * `distill-learnings` prompt: one-shot documentation edit that folds a curated set of
 * machine-collected learnings into an existing project context file's own idempotent
 * `## Learnings (ralphctl)` section.
 *
 * The AI is an editor, not a researcher — every learning was produced and reviewed by an earlier
 * session and confirmed by the operator before this call. The prompt instructs the AI to write
 * the COMPLETE updated context file back to disk (full-file read-back, no signals.json), so this
 * prompt declares no expected harness signals.
 *
 * One real file is written per distinct provider's native context file name (CLAUDE.md /
 * `.github/copilot-instructions.md` / AGENTS.md) — `targetFilename` carries that name so the
 * prompt copy and the AI's write target agree. The distill sub-chain supplies the per-
 * provider value.
 */

import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

export interface DistillLearningsPromptParams {
  /**
   * Existing context-file body wrapped for prompting, or an explicit "no existing file" line. The
   * AI reconciles the candidate learnings against this file's current `## Learnings (ralphctl)`
   * section and writes the full updated file back.
   */
  readonly existingContextFile: string;
  /**
   * The curated learnings to fold in — rendered as a markdown list (one bullet per learning) by
   * the caller from the accepted {@link LearningRecord}s.
   */
  readonly candidateLearnings: string;
  /**
   * Native context-file name for the provider this call targets (e.g. `CLAUDE.md`,
   * `.github/copilot-instructions.md`, `AGENTS.md`). Both the prompt copy and the AI's write
   * target reference it, so the per-provider fan-out lands one file per provider.
   */
  readonly targetFilename: string;
  /**
   * Detected project build/test/task tooling, or an explicit "(none detected)" line. The ONLY
   * place package-manager commands may appear — learnings that name a command are phrased against
   * this section so the prompt copy never hardcodes a specific ecosystem's commands.
   */
  readonly projectTooling: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const distillLearningsPromptDef: PromptDefinition<DistillLearningsPromptParams> = {
  templateName: 'distill-learnings',
  description:
    'One-shot documentation edit that folds curated learnings into an existing project context file’s own idempotent `## Learnings (ralphctl)` section.',
  parameters: {
    existingContextFile: {
      placeholder: 'EXISTING_CONTEXT_FILE',
      description: 'Existing context-file body wrapped for prompting, or an explicit "no existing file" line.',
    },
    candidateLearnings: {
      placeholder: 'CANDIDATE_LEARNINGS',
      description: 'Markdown list of the curated learnings to fold into the context file.',
      validate: requireNonEmpty('candidateLearnings', 'candidate learnings must not be empty'),
    },
    targetFilename: {
      placeholder: 'TARGET_FILENAME',
      description:
        'Native context-file name for the target provider (CLAUDE.md / .github/copilot-instructions.md / AGENTS.md).',
      validate: requireNonEmpty('targetFilename', 'target filename must not be empty'),
    },
    projectTooling: {
      placeholder: 'PROJECT_TOOLING',
      description:
        'Detected build/test/task tooling, or "(none detected)". The only place package-manager commands may appear.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  // The AI writes the full updated context file back to disk directly; no harness signals.
  expectedSignals: [],
};

export interface BuildDistillLearningsPromptInput {
  readonly existingContextFile: string;
  readonly candidateLearnings: string;
  readonly targetFilename: string;
  readonly projectTooling: string;
}

/**
 * Top-level builder — the distill sub-chain consumes this to render the prompt before the
 * AI spawn. Exported ahead of that caller landing.
 *
 * @public
 */
export const buildDistillLearningsPrompt = async (
  loader: TemplateLoader,
  input: BuildDistillLearningsPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(loader, distillLearningsPromptDef, {
    existingContextFile: input.existingContextFile,
    candidateLearnings: input.candidateLearnings,
    targetFilename: input.targetFilename,
    projectTooling: input.projectTooling,
  });
