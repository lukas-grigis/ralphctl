import { type Result } from '@src/domain/result.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderPlateauDirectiveSection,
  renderPreVerifyResultsSection,
  renderPriorCritiqueSection,
  renderRetryFeedbackSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the implement-continuation template.
 *
 * The continuation template is sent on round 2+ of a generator session thread — when the
 * provider reported a `session_id` on the prior round and the leaf forwards it as `--resume`.
 * Because the resumed conversation already holds the full task brief, contract, and the
 * generator's earlier work, the continuation prompt carries only the per-round DELTA: the
 * evaluator's critique, the plateau-break directive, the current round number, a capped recent
 * slice of the sprint journal, and the audit-[09] output-contract block (which names THIS
 * round's `signals.json` path). On-disk paths to the contract and the sprint journal ride along
 * as a graceful-degradation hedge — if a resumed thread loses its prior context (the codex
 * cold-resume fallback drops `--resume` and re-issues the same prompt against a fresh session),
 * the prompt is still self-rescuing because it tells the model where to re-read the brief.
 *
 * Every slot below is a typed string the chain leaf renders before calling `buildPrompt`.
 */
export interface ImplementContinuationPromptParams {
  /** Current gen-eval round number rendered as a string — `{{ROUND_NUMBER}}`. */
  readonly roundNumber: string;
  /**
   * Absolute path to the per-task `contract.md` sidecar — `{{CONTRACT_PATH}}`. Named in the
   * session-context hedge so a context-free resumed thread can re-read the authoritative
   * definition of done.
   */
  readonly contractPath: string;
  /**
   * Absolute path to the sprint `progress.md` journal — `{{PROGRESS_FILE}}`. Named in the
   * session-context hedge and again under the prior-progress block so the model can re-read the
   * full history when the inline excerpt is insufficient.
   */
  readonly progressFile: string;
  /**
   * Capped body of the sprint journal substituted into the `<prior_progress>` block — the
   * sprint header plus the last few attempt sections. Empty string when the journal has no
   * entries yet. The full file stays on disk at `{{PROGRESS_FILE}}`.
   */
  readonly priorProgress: string;
  /**
   * "## Prior Critique" markdown block — the evaluator's failed-verdict critique from the
   * previous round, rendered verbatim. Non-empty on every continuation turn (a continuation is
   * only sent after the loop kept going, which means the prior round did not pass). Rendered via
   * the shared `renderPriorCritiqueSection`.
   */
  readonly priorCritiqueSection: string;
  /**
   * Summaries of the most instructive prior attempts on THIS task (a curated select-K slice, not
   * the full attempt history) with their verification outcomes — what passed and what regressed.
   * Absent or empty → `{{PRIOR_ATTEMPTS_SECTION}}` collapses cleanly (no `<prior_attempts>` block
   * is emitted). Default undefined (empty) until the caller threads a selection.
   */
  readonly priorAttemptsSection?: string;
  /**
   * Optional `<reproduction>` block — when a `reproduce` session already wrote a failing test for
   * this defect-shaped task, its test path, run command, and observed failure ride here. Absent
   * or empty → `{{REPRODUCTION_SECTION}}` collapses cleanly (no orphan block).
   */
  readonly reproductionSection?: string;
  /**
   * "## ⚠ You have plateaued — change your approach" block — empty unless this round is a
   * plateau-break attempt (top-of-ladder same-model nudge). Rendered via the shared
   * `renderPlateauDirectiveSection`.
   */
  readonly plateauDirectiveSection: string;
  /**
   * Audit-[09] output contract section rendered from the generator contract for THIS round's
   * output directory (`rounds/<N>/generator/`). Because the leaf re-renders it per round, the
   * embedded `signals.json` path always names the current round — `{{OUTPUT_CONTRACT_SECTION}}`.
   */
  readonly outputContractSection: string;
  /**
   * Verbatim output (or trimmed tail) from the harness pre-task verify run, inside
   * `<pre_verify_results>…</pre_verify_results>`. Empty string when the harness did not run a
   * pre-verify — placeholder collapses cleanly.
   */
  readonly preVerifyResults: string;
  /**
   * Failing post-verify command + output tail from the previous attempt, inside
   * `<retry_feedback>…</retry_feedback>`. Empty string on a first attempt or when the prior
   * post-verify passed — placeholder collapses cleanly.
   */
  readonly retryFeedbackSection: string;
}

export const implementContinuationPromptDef: PromptDefinition<ImplementContinuationPromptParams> = {
  templateName: 'implement-continuation',
  description:
    'Resumed generator turn (round 2+ of a session thread). Carries only the per-round delta — critique, round number, plateau directive — because the full brief is already in the conversation.',
  parameters: {
    roundNumber: {
      placeholder: 'ROUND_NUMBER',
      description: 'Current gen-eval round number rendered as a string.',
      validate: requireNonEmpty('roundNumber', 'round number must not be empty'),
    },
    contractPath: {
      placeholder: 'CONTRACT_PATH',
      description: 'Absolute path to the per-task contract.md sidecar — re-read hedge for a context-free resume.',
      validate: requireNonEmpty('contractPath', 'contract path must not be empty'),
    },
    progressFile: {
      placeholder: 'PROGRESS_FILE',
      description: 'Absolute path to the sprint progress.md journal — full history when the inline excerpt is short.',
      validate: requireNonEmpty('progressFile', 'progress file path must not be empty'),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description: 'Capped recent slice of progress.md inlined into the prior-progress block — empty when none yet.',
    },
    priorCritiqueSection: {
      placeholder: 'PRIOR_CRITIQUE_SECTION',
      description:
        '"## Prior Critique" markdown block (+ optional "## Dimension trajectory" feed-forward) — the prior round\'s failed evaluator critique and the multi-round dimension trajectory.',
    },
    priorAttemptsSection: {
      placeholder: 'PRIOR_ATTEMPTS_SECTION',
      optional: true,
      description:
        'Summaries of the most instructive prior attempts on this task (select-K slice) with their ' +
        'verification outcomes. Empty → `{{PRIOR_ATTEMPTS_SECTION}}` collapses (no `<prior_attempts>` wrapper).',
    },
    reproductionSection: {
      placeholder: 'REPRODUCTION_SECTION',
      optional: true,
      description:
        'Failing reproduction test a prior `reproduce` session wrote for this defect-shaped task — test ' +
        'path, run command, observed failure. Empty → `{{REPRODUCTION_SECTION}}` collapses (no `<reproduction>` wrapper).',
    },
    plateauDirectiveSection: {
      placeholder: 'PLATEAU_DIRECTIVE_SECTION',
      description:
        '"## ⚠ You have plateaued — change your approach" block — empty unless this round is a plateau-break attempt.',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        "Audit-[09] output contract block rendered for THIS round's output directory — names the current signals.json path.",
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
    preVerifyResults: {
      placeholder: 'PRE_VERIFY_RESULTS',
      description:
        'Verbatim output (or trimmed tail) from the harness pre-task verify run — empty when the harness did not run a pre-verify.',
    },
    retryFeedbackSection: {
      placeholder: 'RETRY_FEEDBACK_SECTION',
      description:
        'Failing post-verify command + output tail from the previous attempt — empty on a first attempt or when the prior post-verify passed.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    DECISIONS_GUIDANCE: 'decisions',
  },
  // Same accepted signal union as the full implement prompt — a continuation turn is still a
  // generator turn and may emit the full narrative + lifecycle set.
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

export interface BuildImplementContinuationPromptInput {
  readonly roundNumber: number;
  /** Absolute path to the per-task `contract.md` sidecar. */
  readonly contractPath: string;
  /** Absolute path to the sprint `progress.md` journal. */
  readonly progressFile: string;
  /** Capped recent slice of the sprint journal body. */
  readonly priorProgress: string;
  /** Prior evaluator critique to feed back into the generator. */
  readonly priorCritique?: string;
  /**
   * Pre-composed summary of the most instructive prior attempts on this task (a curated
   * select-K slice, not the full history) with their verification outcomes. Absent or empty →
   * `{{PRIOR_ATTEMPTS_SECTION}}` collapses (no `<prior_attempts>` block emitted).
   */
  readonly priorAttempts?: string;
  /**
   * Pre-composed body describing a reproduction test a prior `reproduce` session wrote for this
   * defect-shaped task — its test path, run command, and observed failure excerpt. Absent or
   * empty → `{{REPRODUCTION_SECTION}}` collapses (no `<reproduction>` block emitted).
   */
  readonly reproduction?: string;
  /**
   * Pre-composed "## Dimension trajectory" block from `ctx.plateauHistory` — rides inside
   * `PRIOR_CRITIQUE_SECTION` (no new placeholder). Absent on round 1 or empty → not rendered.
   */
  readonly dimensionTrajectory?: string;
  /** True on a top-of-ladder same-model nudge — renders the "change your approach" directive. */
  readonly plateauBreak?: boolean;
  /** Pre-rendered audit-[09] output contract section for this round's generator output dir. */
  readonly outputContractSection: string;
  /**
   * Verbatim output (or trimmed tail) from the harness pre-task verify run. Absent or empty →
   * `{{PRE_VERIFY_RESULTS}}` collapses cleanly inside `<pre_verify_results>`.
   */
  readonly preVerifyOutput?: string;
  /**
   * Failing post-verify command + output tail when a prior attempt's harness post-verify failed
   * with `attribution === 'regressed'`. Absent or empty → `{{RETRY_FEEDBACK_SECTION}}` collapses.
   */
  readonly retryFeedback?: string;
}

/**
 * Render the optional `<prior_attempts>` block — the most instructive prior attempts on this
 * task (select-K slice) with their verification outcomes. Same collapse contract as the sibling
 * renderers in this module: full tagged block when non-empty, empty string otherwise so
 * `{{PRIOR_ATTEMPTS_SECTION}}` disappears cleanly with no orphan wrapper.
 */
const renderPriorAttemptsSection = (summary: string | undefined): string => {
  if (summary === undefined) return '';
  const trimmed = summary.trim();
  if (trimmed.length === 0) return '';
  return ['<prior_attempts>', trimmed, '</prior_attempts>'].join('\n');
};

/**
 * Render the optional `<reproduction>` block — a failing test a prior `reproduce` session wrote
 * for this defect-shaped task. Same collapse contract as the sibling renderers above: full
 * tagged block (with an embedded framing header, since the block disappears entirely when
 * empty) when non-empty, empty string otherwise so `{{REPRODUCTION_SECTION}}` disappears
 * cleanly with no orphan wrapper.
 */
const renderReproductionSection = (reproduction: string | undefined): string => {
  if (reproduction === undefined) return '';
  const trimmed = reproduction.trim();
  if (trimmed.length === 0) return '';
  return [
    '<reproduction>',
    'A failing reproduction test already exists for this task, written in an earlier session. Make it',
    'pass without weakening it — do not delete, skip, or loosen its assertions to reach a pass.',
    '',
    trimmed,
    '</reproduction>',
  ].join('\n');
};

/**
 * Top-level builder — renders the param strings, calls `buildPrompt`. The chain leaf consumes
 * this via function injection on round 2+ of a generator session thread.
 */
export const buildImplementContinuationPrompt = async (
  deps: TemplateLoader,
  input: BuildImplementContinuationPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, implementContinuationPromptDef, {
    roundNumber: String(input.roundNumber),
    contractPath: input.contractPath,
    progressFile: input.progressFile,
    priorProgress: input.priorProgress,
    priorCritiqueSection: renderPriorCritiqueSection(input.priorCritique, input.dimensionTrajectory),
    priorAttemptsSection: renderPriorAttemptsSection(input.priorAttempts),
    reproductionSection: renderReproductionSection(input.reproduction),
    plateauDirectiveSection: renderPlateauDirectiveSection(input.plateauBreak ?? false),
    outputContractSection: input.outputContractSection,
    preVerifyResults: renderPreVerifyResultsSection(input.preVerifyOutput),
    retryFeedbackSection: renderRetryFeedbackSection(input.retryFeedback),
  });
