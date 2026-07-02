import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import { renderFloorRubricSection } from '@src/integration/ai/prompts/_engine/renderers/floor-rubric.ts';
import { renderGeneratorHintsSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the evaluate-continuation template.
 *
 * The continuation template is sent on round 2+ of an evaluator session thread — when the
 * provider reported a `session_id` on the prior round and the leaf forwards it as `--resume`.
 * The resumed conversation already holds the task specification, the contract, and the
 * reviewer's prior grading, so the continuation prompt carries only the per-round delta: the
 * current round number, a capped recent slice of the sprint journal, and the audit-[09]
 * output-contract block (which names THIS round's `signals.json` path). The full grading rubric
 * and verdict semantics are re-stated inline — kept consistent with `evaluate/template.md` — so
 * the reviewer never drifts on the floor dimensions or the malformed semantics across rounds.
 * On-disk paths to the contract and the sprint journal ride along as a graceful-degradation
 * hedge: if a resumed thread loses its prior context (the codex cold-resume fallback drops
 * `--resume` and re-issues the same prompt against a fresh session), the prompt is still
 * self-rescuing because it tells the model where to re-read the specification.
 *
 * Every slot below is a typed string the chain leaf renders before calling `buildPrompt`.
 */
export interface EvaluateContinuationPromptParams {
  /** Current gen-eval round number rendered as a string — `{{ROUND_NUMBER}}`. */
  readonly roundNumber: string;
  /**
   * Absolute path to the per-task `contract.md` sidecar — `{{CONTRACT_PATH}}`. Named in the
   * session-context hedge so a context-free resumed thread can re-read the criteria it grades.
   */
  readonly contractPath: string;
  /**
   * Absolute path to the sprint `progress.md` journal — `{{PROGRESS_FILE}}`. Named in the
   * session-context hedge and under the prior-progress block so the reviewer can re-read the
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
   * Rendered `{{FLOOR_RUBRIC_SECTION}}` markdown block — the five floor dimensions, each with a
   * rationale-before-verdict block, single-sourced from `FLOOR_DIMENSIONS` via
   * {@link renderFloorRubricSection}. Kept consistent with `evaluate/template.md` so the
   * reviewer never drifts on the rubric across rounds. Always non-empty.
   */
  readonly floorRubricSection: string;
  /**
   * Audit-[09] output contract section rendered from the evaluator contract for THIS round's
   * output directory (`rounds/<N>/evaluator/`). Because the leaf re-renders it per round, the
   * embedded `signals.json` path always names the current round — `{{OUTPUT_CONTRACT_SECTION}}`.
   */
  readonly outputContractSection: string;
  /**
   * Same-round generator observations rendered inside a `<generator_hints>` block. Framed as
   * unverified claims — useful for environment context, never as evidence. Empty string when no
   * hints were collected — `{{GENERATOR_HINTS_SECTION}}` collapses cleanly.
   */
  readonly generatorHintsSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const evaluateContinuationPromptDef: PromptDefinition<EvaluateContinuationPromptParams> = {
  templateName: 'evaluate-continuation',
  description:
    'Resumed evaluator turn (round 2+ of a session thread). Carries only the per-round delta — round number, recent journal — because the specification and rubric are already in the conversation.',
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
    floorRubricSection: {
      placeholder: 'FLOOR_RUBRIC_SECTION',
      description:
        'The five floor dimensions, each rendered as a rationale-before-verdict block, single-sourced from FLOOR_DIMENSIONS.',
      validate: requireNonEmpty(
        'floorRubricSection',
        'floor-rubric section must not be empty (renderFloorRubricSection always emits a body)'
      ),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        "Audit-[09] output contract block rendered for THIS round's evaluator output directory — names the current signals.json path.",
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
    generatorHintsSection: {
      placeholder: 'GENERATOR_HINTS_SECTION',
      description:
        'Same-round generator observations (environment notes, learnings) framed as unverified context inside a <generator_hints> block — empty when no hints were collected.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  // Same single-signal contract as the full evaluate prompt — a continuation turn still emits
  // exactly one `evaluation` verdict.
  expectedSignals: ['evaluation'],
};

export interface BuildEvaluateContinuationPromptInput {
  readonly roundNumber: number;
  /** Absolute path to the per-task `contract.md` sidecar. */
  readonly contractPath: string;
  /** Absolute path to the sprint `progress.md` journal. */
  readonly progressFile: string;
  /** Capped recent slice of the sprint journal body. */
  readonly priorProgress: string;
  /** Pre-rendered audit-[09] output contract section for this round's evaluator output dir. */
  readonly outputContractSection: string;
  /**
   * Same-round generator observations to thread to the evaluator as environment hints. Framed
   * as unverified claims — useful for environment context, never as evidence. Omitted or empty
   * → `{{GENERATOR_HINTS_SECTION}}` collapses cleanly.
   */
  readonly generatorHints?: string;
}

/**
 * Top-level builder — renders the param strings, calls `buildPrompt`. The chain leaf consumes
 * this via function injection on round 2+ of an evaluator session thread.
 */
export const buildEvaluateContinuationPrompt = async (
  deps: TemplateLoader,
  input: BuildEvaluateContinuationPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, evaluateContinuationPromptDef, {
    roundNumber: String(input.roundNumber),
    contractPath: input.contractPath,
    progressFile: input.progressFile,
    priorProgress: input.priorProgress,
    floorRubricSection: renderFloorRubricSection(),
    outputContractSection: input.outputContractSection,
    generatorHintsSection: renderGeneratorHintsSection(input.generatorHints),
  });
