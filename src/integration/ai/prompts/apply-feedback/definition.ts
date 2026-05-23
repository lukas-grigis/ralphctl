import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the apply-feedback template. The review-chain use case
 * builds these strings from the sprint state, the feedback log, and the latest round, then
 * calls `buildPrompt` to produce the prompt fed to the AI.
 *
 * The four free-form sections are rendered by the use case (not the template) so the use case
 * controls separator handling, history truncation, and round formatting in one place.
 */
export interface ApplyFeedbackPromptParams {
  /**
   * Pre-rendered Markdown list of repositories the sprint targets — `{{REPOSITORIES}}`.
   * Each line is `- \`<absolute-path>\` (<name>)`. The launcher derives the set from the
   * sprint's tasks (`Task.repositoryId`) joined against `Project.repositories`. The AI
   * decides which repository (or repositories) the latest round touches based on the
   * feedback content.
   */
  readonly repositories: string;
  /** Sprint metadata (slug, name, ticket count) — `{{SPRINT_CONTEXT}}`. */
  readonly sprintContext: string;
  /** Concatenated history of every prior round — `{{FEEDBACK_LOG}}`. */
  readonly feedbackLog: string;
  /** The current round body the AI must act on — `{{LATEST_ROUND}}`. */
  readonly latestRound: string;
  /** Pinned-section snapshot of `progress.md` — `{{PROGRESS}}`. */
  readonly progress: string;
  /**
   * Audit-[09] output contract section — rendered from the review-round `AiOutputContract`
   * by `renderContractSectionFor(reviewRoundOutputContract)`. Instructs the AI to write
   * `signals.json` directly with exactly one of `task-complete` or `task-blocked`.
   */
  readonly outputContractSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const applyFeedbackPromptDef: PromptDefinition<ApplyFeedbackPromptParams> = {
  templateName: 'apply-feedback',
  description:
    'Apply one round of human feedback to an already-implemented sprint. Review-time work, not initial implementation.',
  parameters: {
    repositories: {
      placeholder: 'REPOSITORIES',
      description:
        'Markdown list of every sprint-affected repository (absolute path + display name). The AI picks which to touch based on the latest round.',
      validate: requireNonEmpty('repositories', 'repositories block must not be empty'),
    },
    sprintContext: {
      placeholder: 'SPRINT_CONTEXT',
      description: 'Sprint metadata block (slug, name, ticket count).',
      validate: requireNonEmpty('sprintContext', 'sprint context must not be empty'),
    },
    feedbackLog: {
      placeholder: 'FEEDBACK_LOG',
      description: 'Full history of prior rounds in this review (empty for round 1).',
    },
    latestRound: {
      placeholder: 'LATEST_ROUND',
      description: 'The round body the AI must act on now.',
      validate: requireNonEmpty('latestRound', 'latest round body must not be empty'),
    },
    progress: {
      placeholder: 'PROGRESS',
      description: 'Snapshot of progress.md (pinned learnings + decisions + recent activity).',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the review-round contract — instructs the AI to write `signals.json` directly with exactly one terminal signal.',
      validate: requireNonEmpty('outputContractSection', 'output-contract section must not be empty'),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['task-complete', 'task-blocked'],
};

export interface BuildApplyFeedbackPromptInput {
  readonly repositories: string;
  readonly sprintContext: string;
  readonly feedbackLog: string;
  readonly latestRound: string;
  readonly progress: string;
  readonly outputContractSection: string;
}

export const buildApplyFeedbackPrompt = async (
  deps: TemplateLoader,
  input: BuildApplyFeedbackPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, applyFeedbackPromptDef, {
    repositories: input.repositories,
    sprintContext: input.sprintContext,
    feedbackLog: input.feedbackLog,
    latestRound: input.latestRound,
    progress: input.progress,
    outputContractSection: input.outputContractSection,
  });
