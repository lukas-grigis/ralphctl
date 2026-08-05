import { type Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderTaskDescriptionSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';

/**
 * `select-candidate` prompt: one-shot best-of-N judge session. The session receives the task
 * goal + acceptance criteria and TWO candidate summaries (what was attempted, verification
 * outcome, changed files, notable signals), labelled by index, and picks the candidate more
 * likely to be a correct, complete, maintainable solution — judging evidence over confidence,
 * penalising unverified claims.
 *
 * Research grounding: arXiv 2604.16529 (Meta, Parallel-Distill-Refine) — pairwise comparison
 * over compact structured summaries is the measured selection mechanism; judges compare
 * summaries, never raw transcripts. The session is deliberately given NO repository access — the
 * prompt instructs it to judge from the two summaries alone, mirroring the paper's setup.
 */
export interface SelectCandidatePromptParams {
  /** Task display name — `{{TASK_NAME}}`. */
  readonly taskName: string;
  /** Markdown block "## Description\n\n…" or empty when the task has no description. */
  readonly taskDescriptionSection: string;
  /** Markdown block "## Done criteria\n\n- …" or empty when there are none. */
  readonly verificationCriteriaSection: string;
  /**
   * Compact structured summary of Candidate 1 — what was attempted, verification outcome,
   * changed files, notable signals (warnings, learnings). Caller-composed; this module has no
   * opinion on the exact rendering, only that it is compact and structured per the research
   * grounding above.
   */
  readonly candidateASummary: string;
  /** Compact structured summary of Candidate 2, same shape as {@link candidateASummary}. */
  readonly candidateBSummary: string;
  /**
   * Audit-[09] output contract section — rendered from the select-candidate `AiOutputContract`
   * by `renderContractSectionFor(selectCandidateOutputContract)`. Tells the AI to write
   * `signals.json` with exactly one `candidate-selection` signal.
   */
  readonly outputContractSection: string;
}

export const selectCandidatePromptDef: PromptDefinition<SelectCandidatePromptParams> = {
  templateName: 'select-candidate',
  description:
    'One-shot best-of-N judge. Compares two candidate solutions by their compact structured summaries only (never raw diffs) and picks the stronger one.',
  parameters: {
    taskName: {
      placeholder: 'TASK_NAME',
      description: 'Task display name.',
      validate: requireNonEmpty('taskName', 'task name must not be empty'),
    },
    taskDescriptionSection: {
      placeholder: 'TASK_DESCRIPTION_SECTION',
      description: '"## Description" markdown block, or empty when the task has no description.',
    },
    verificationCriteriaSection: {
      placeholder: 'VERIFICATION_CRITERIA_SECTION',
      description: '"## Done criteria" bullet list, or empty when none are declared.',
    },
    candidateASummary: {
      placeholder: 'CANDIDATE_A_SUMMARY',
      description:
        "Candidate 1's compact structured summary — what was attempted, verification outcome, changed files, notable signals.",
      validate: requireNonEmpty('candidateASummary', 'candidate A summary must not be empty'),
    },
    candidateBSummary: {
      placeholder: 'CANDIDATE_B_SUMMARY',
      description: "Candidate 2's compact structured summary, same shape as candidate A's.",
      validate: requireNonEmpty('candidateBSummary', 'candidate B summary must not be empty'),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the select-candidate contract — instructs the AI to write `signals.json` directly.',
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['candidate-selection'],
};

export interface BuildSelectCandidatePromptInput {
  readonly task: Task;
  /** Candidate 1's compact structured summary. */
  readonly candidateASummary: string;
  /** Candidate 2's compact structured summary. */
  readonly candidateBSummary: string;
  /**
   * Pre-rendered audit-[09] output contract section. The leaf composes this via
   * `renderContractSectionFor(selectCandidateOutputContract)` before calling the builder.
   */
  readonly outputContractSection: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 */
export const buildSelectCandidatePrompt = async (
  deps: TemplateLoader,
  input: BuildSelectCandidatePromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, selectCandidatePromptDef, {
    taskName: input.task.name,
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    candidateASummary: input.candidateASummary,
    candidateBSummary: input.candidateBSummary,
    outputContractSection: input.outputContractSection,
  });
