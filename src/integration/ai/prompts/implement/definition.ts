import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderPlateauDirectiveSection,
  renderPreVerifyResultsSection,
  renderPriorCritiqueSection,
  renderPriorLearningsSection,
  renderProjectToolingSection,
  renderRetryFeedbackSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
  renderVerifyScriptSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

// Re-export the shared task renderers from this module so consumers (and tests) that already
// import them from `definitions/implement.ts` keep working after the lift to
// `renderers/task.ts`. The originals lived here historically; the actual implementations are
// now in the shared module.
export {
  renderVerifyScriptSection,
  renderPriorCritiqueSection,
  renderPriorLearningsSection,
  renderPlateauDirectiveSection,
  renderPreVerifyResultsSection,
  renderProjectToolingSection,
  renderRetryFeedbackSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
};

/**
 * Pre-rendered string parameters for the implement template. The renderer helpers below
 * produce each block from domain types; callers can also build the strings by hand for tests.
 *
 * The implement template tells one task implementer agent how to execute a single
 * pre-planned task: read the description / steps / verification criteria, run the verify
 * script as the post-task gate, then emit signals plus `<task-complete>`. The harness
 * renders those signals into `progress.md` on the next snapshot — the agent must NOT write
 * to the file directly. Every slot below is a typed string the chain leaf renders before
 * calling `buildPrompt`.
 */
export interface ImplementPromptParams {
  /** Task display name — `{{TASK_NAME}}` (the level-1 heading body in the rendered prompt). */
  readonly taskName: string;
  /** Task id rendered as a string — `{{TASK_ID}}`. */
  readonly taskId: string;
  /** Absolute project path the task targets — `{{PROJECT_PATH}}`. */
  readonly projectPath: string;
  /**
   * Absolute path to the per-task `contract.md` sidecar — substituted into the template's
   * `{{CONTRACT_PATH}}` placeholder. The implementer reads the contract before coding so the
   * canonical definition of done matches the per-criterion table the evaluator grades against.
   */
  readonly contractPath: string;
  /** Markdown block "## Description\n\n…" or empty when the task has no description. */
  readonly taskDescriptionSection: string;
  /** Markdown block "## Implementation Steps\n\n1. …" or empty when there are no steps. */
  readonly taskStepsSection: string;
  /** Markdown block "## Done criteria\n\n- …" or empty when there are none. */
  readonly verificationCriteriaSection: string;
  /**
   * Markdown body for the "## Verify Script" section — either a fenced shell block with the
   * configured command or the explicit "no verify script configured" line. Always non-empty.
   */
  readonly verifyScriptSection: string;
  /** Detected subagents / skills / MCP servers the implementer can route to, or fallback. */
  readonly projectTooling: string;
  /** Absolute path to `progress.md` for this sprint — `{{PROGRESS_FILE}}`. */
  readonly progressFile: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress` section
   * (audit-[07]). Empty string when the journal file is absent — the template's surrounding
   * prose handles the empty case without a per-flow special branch.
   */
  readonly priorProgress: string;
  /**
   * Markdown body for "## Learnings from prior sprints" — this project's not-yet-promoted ledger
   * insights (principle 3, read side). Empty string when the ledger is absent / empty so the
   * surrounding template prose handles the empty case without a per-flow branch.
   */
  readonly priorLearningsSection: string;
  /**
   * Markdown body for "## Prior Critique" — empty on turn 1, populated on every subsequent
   * turn of the gen-eval loop with the failed evaluator critique from the previous turn so
   * the generator's fix attempt addresses the same dimensions the evaluator flagged.
   */
  readonly priorCritiqueSection: string;
  /**
   * "## ⚠ You have plateaued — change your approach" block — empty unless this is a plateau-break
   * attempt (the gen-eval loop stalled and the escalation policy granted one more attempt). Tells
   * the generator to abandon the non-converging approach and try a fundamentally different one.
   */
  readonly plateauDirectiveSection: string;
  /**
   * Audit-[09] output contract section — rendered from the generator's `AiOutputContract` by
   * `renderContractSectionFor(generatorOutputContract)`. Tells the AI to write exactly one
   * file (`signals.json`) matching the documented shape and to not write any other files.
   * The leaf composes this string before calling `buildImplementPrompt`.
   */
  readonly outputContractSection: string;
  /**
   * Verbatim output (or a trimmed tail) from the harness pre-task verification run, injected
   * inside `<pre_verify_results>…</pre_verify_results>`. When non-empty the generator reviews
   * baseline state rather than re-running the verify script. Empty string when the harness did
   * not run a pre-verify (e.g. first task of a fresh setup).
   */
  readonly preVerifyResults: string;
  /**
   * When a previous attempt's harness post-verify failed, this carries the failing command and
   * a tail of its output, injected inside `<retry_feedback>…</retry_feedback>`. Tells the
   * generator to treat fixing that regression as the first priority of this attempt. Empty
   * string on a first attempt or when the prior post-verify passed.
   */
  readonly retryFeedbackSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const implementPromptDef: PromptDefinition<ImplementPromptParams> = {
  templateName: 'implement',
  description:
    'One-shot task execution. The agent reads the task body, runs the verify script, and emits harness signals; the harness snapshots those signals into progress.md.',
  parameters: {
    taskName: {
      placeholder: 'TASK_NAME',
      description: 'Task display name — used as the level-1 heading.',
      validate: requireNonEmpty('taskName', 'task name must not be empty'),
    },
    taskId: {
      placeholder: 'TASK_ID',
      description: 'Task id rendered as a string (e.g. UUID).',
      validate: requireNonEmpty('taskId', 'task id must not be empty'),
    },
    projectPath: {
      placeholder: 'PROJECT_PATH',
      description: 'Absolute path to the project the task targets.',
      validate: requireNonEmpty('projectPath', 'project path must not be empty'),
    },
    contractPath: {
      placeholder: 'CONTRACT_PATH',
      description: 'Absolute path to the per-task contract.md sidecar — authoritative definition of done.',
      validate: requireNonEmpty('contractPath', 'contract path must not be empty'),
    },
    taskDescriptionSection: {
      placeholder: 'TASK_DESCRIPTION_SECTION',
      description: '"## Description" markdown block, or empty when the task has no description.',
    },
    taskStepsSection: {
      placeholder: 'TASK_STEPS_SECTION',
      description: '"## Implementation Steps" numbered list, or empty when no steps are declared.',
    },
    verificationCriteriaSection: {
      placeholder: 'VERIFICATION_CRITERIA_SECTION',
      description: '"## Done criteria" bullet list, or empty when none are declared.',
    },
    verifyScriptSection: {
      placeholder: 'VERIFY_SCRIPT_SECTION',
      description:
        'Body of the "## Verify Script" section — fenced shell block when configured, explicit "no verify script configured" otherwise.',
      validate: requireNonEmpty(
        'verifyScriptSection',
        'verify-script section must not be empty (renderVerifyScriptSection always emits a body)'
      ),
    },
    projectTooling: {
      placeholder: 'PROJECT_TOOLING',
      description: 'Detected subagents, skills, MCP servers, or "(none detected)".',
    },
    progressFile: {
      placeholder: 'PROGRESS_FILE',
      description:
        'Absolute path to the sprint progress.md file the implementer reads at the start of Phase 1 for cross-session context.',
      validate: requireNonEmpty('progressFile', 'progress file path must not be empty'),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description:
        'Current body of `progress.md` substituted into the `## Prior progress` section — empty when the journal has no entries yet.',
    },
    priorLearningsSection: {
      placeholder: 'PRIOR_LEARNINGS',
      description:
        '"## Learnings from prior sprints" block — this project\'s not-yet-promoted ledger insights; empty when none recorded yet.',
    },
    priorCritiqueSection: {
      placeholder: 'PRIOR_CRITIQUE_SECTION',
      description:
        '"## Prior Critique" markdown block (+ optional "## Dimension trajectory" feed-forward) — empty on turn 1, the evaluator\'s failed critique and multi-round dimension trajectory on turn 2+.',
    },
    plateauDirectiveSection: {
      placeholder: 'PLATEAU_DIRECTIVE_SECTION',
      description:
        '"## ⚠ You have plateaued — change your approach" block — empty unless this is a plateau-break attempt.',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the generator contract — instructs the AI to write `signals.json` directly.',
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
  // Documents the harness signals the implement response is expected to carry. Validation is
  // not enforced at parse time — this list drives test authors and future scoped parsers.
  // Aligned with generator.contract.ts: narrative fan-out (change, decision, learning, note)
  // plus lifecycle signals (task-verified, task-complete, task-blocked, commit-message).
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

export interface BuildImplementPromptInput {
  readonly task: Task;
  readonly projectPath: string;
  /** Absolute path to the per-task `contract.md` sidecar (written by `build-task-workspace`). */
  readonly contractPath: string;
  readonly verifyScript?: string;
  readonly progressFile: string;
  /** Current `progress.md` body — inlined into the prompt's "## Prior progress" section. */
  readonly priorProgress: string;
  /**
   * Pre-composed "## Learnings from prior sprints" body — this project's not-yet-promoted ledger
   * insights (principle 3, read side). Absent or empty → the `{{PRIOR_LEARNINGS}}` placeholder
   * collapses cleanly. Built application-side by `composePriorLearnings` and passed in by the leaf.
   */
  readonly priorLearnings?: string;
  readonly projectTooling?: string;
  /**
   * Prior evaluator critique to feed back into the generator on turn 2+. Absent on turn 1
   * (no prior critique yet). The chain leaf reads the running attempt's `critique` field —
   * populated by the previous evaluator turn — and threads it through here so the generator
   * fix attempt sees the same dimensions the evaluator graded last.
   */
  readonly priorCritique?: string;
  /**
   * Pre-composed "## Dimension trajectory" block built from `ctx.plateauHistory` by
   * `composeDimensionTrajectory` — the failed-dimension feed-forward (fixed / still-failing-for-N /
   * newly-failing) plus the plateau-budget pressure line. Rides inside `PRIOR_CRITIQUE_SECTION` so no
   * new placeholder is needed. Absent on round 1 (no trajectory to diff yet) or empty → not rendered.
   */
  readonly dimensionTrajectory?: string;
  /**
   * True on a top-of-ladder same-model nudge — the gen-eval loop stalled at the strongest rung and
   * one more attempt was granted on the SAME model. Renders the "change your approach" directive.
   * The generator leaf sets it from `task.escalatedFromModel === task.escalatedToModel` (the
   * same-model marker), NOT from a model bump: a bump hands the stronger model the targeted prior
   * critique instead, so the directive is reserved for the nudge where no fresh capability remains.
   * The escalation fields are re-stampable as the generator climbs the ladder, so this flips on only
   * when the latest transition is a same-model nudge. Default false (no nudge in effect).
   */
  readonly plateauBreak?: boolean;
  /**
   * Pre-rendered audit-[09] output contract section. The leaf composes this via
   * `renderContractSectionFor(generatorOutputContract)` before calling the builder so the
   * prompt module stays agnostic of the per-leaf contract.
   */
  readonly outputContractSection: string;
  /**
   * Verbatim output (or trimmed tail) from the harness pre-task verify run. When provided the
   * generator reviews the baseline state without re-running. Absent or empty → placeholder
   * collapses inside `<pre_verify_results>…</pre_verify_results>`.
   */
  readonly preVerifyOutput?: string;
  /**
   * Failing post-verify command + output tail from the previous attempt, injected when a prior
   * attempt's harness post-verify failed with `attribution === 'regressed'`. Absent or empty →
   * placeholder collapses inside `<retry_feedback>…</retry_feedback>`.
   */
  readonly retryFeedback?: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 * The chain leaf consumes this via function injection.
 */
export const buildImplementPrompt = async (
  deps: TemplateLoader,
  input: BuildImplementPromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, implementPromptDef, {
    taskName: input.task.name,
    taskId: String(input.task.id),
    projectPath: input.projectPath,
    contractPath: input.contractPath,
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    taskStepsSection: renderTaskStepsSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    verifyScriptSection: renderVerifyScriptSection(input.verifyScript),
    projectTooling: renderProjectToolingSection(input.projectTooling),
    progressFile: input.progressFile,
    priorProgress: input.priorProgress,
    priorLearningsSection: renderPriorLearningsSection(input.priorLearnings),
    priorCritiqueSection: renderPriorCritiqueSection(input.priorCritique, input.dimensionTrajectory),
    plateauDirectiveSection: renderPlateauDirectiveSection(input.plateauBreak ?? false),
    outputContractSection: input.outputContractSection,
    preVerifyResults: renderPreVerifyResultsSection(input.preVerifyOutput),
    retryFeedbackSection: renderRetryFeedbackSection(input.retryFeedback),
  });
