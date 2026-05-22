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
  /** Absolute path to the project — `{{PROJECT_PATH}}`. */
  readonly projectPath: string;
  /** Sprint metadata (slug, name, ticket count) — `{{SPRINT_CONTEXT}}`. */
  readonly sprintContext: string;
  /** Concatenated history of every prior round — `{{FEEDBACK_LOG}}`. */
  readonly feedbackLog: string;
  /** The current round body the AI must act on — `{{LATEST_ROUND}}`. */
  readonly latestRound: string;
  /** Pinned-section snapshot of `progress.md` — `{{PROGRESS}}`. */
  readonly progress: string;
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
    projectPath: {
      placeholder: 'PROJECT_PATH',
      description: 'Absolute path to the project the sprint targets.',
      validate: requireNonEmpty('projectPath', 'project path must not be empty'),
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
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    SIGNALS: 'signals-feedback',
  },
  expectedSignals: ['task-complete', 'task-blocked'],
};

export interface BuildApplyFeedbackPromptInput {
  readonly projectPath: string;
  readonly sprintContext: string;
  readonly feedbackLog: string;
  readonly latestRound: string;
  readonly progress: string;
}

export const buildApplyFeedbackPrompt = async (
  deps: TemplateLoader,
  input: BuildApplyFeedbackPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, applyFeedbackPromptDef, {
    projectPath: input.projectPath,
    sprintContext: input.sprintContext,
    feedbackLog: input.feedbackLog,
    latestRound: input.latestRound,
    progress: input.progress,
  });
