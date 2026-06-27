import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderExtraDimensionsSection,
  renderGeneratorHintsSection,
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
  renderVerifyScriptSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the evaluate template. Mirrors the implement
 * definition's task-shaped slots — the evaluator reviews the same task spec the implementer
 * just executed against — but omits the implementer-specific identifiers (TASK_ID,
 * PROGRESS_FILE) and substitutes the audit-[09] `{{OUTPUT_CONTRACT_SECTION}}` produced from the
 * evaluator's `AiOutputContract`.
 *
 * The evaluate template runs an independent reviewer agent: it reads the task description /
 * steps / verification criteria, runs the verify script as authoritative ground truth, scores
 * four floor dimensions (correctness, completeness, safety, consistency), and writes exactly
 * one `evaluation` signal to `signals.json` carrying the PASS / FAIL verdict + per-dimension
 * findings.
 */
export interface EvaluatePromptParams {
  /** Task display name — `{{TASK_NAME}}` (referenced both as the page title and inside the spec block). */
  readonly taskName: string;
  /** Absolute project path the task targets — `{{PROJECT_PATH}}`. */
  readonly projectPath: string;
  /**
   * Absolute path to the per-task `contract.md` sidecar — substituted into the template's
   * `{{CONTRACT_PATH}}` placeholder. The reviewer reads the contract before grading so the
   * per-criterion assessment matches the canonical id / check / command / assertion table.
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
  /** Detected subagents / skills / MCP servers the reviewer can route to, or fallback. */
  readonly projectTooling: string;
  /**
   * Optional "Task-specific dimensions" block appended after the four floor dimensions. Empty
   * string when the planner didn't attach extras to this task — keeps the template stable.
   */
  readonly extraDimensionsSection: string;
  /**
   * Audit-[09] output contract section — rendered from the evaluator's `AiOutputContract` by
   * `renderContractSectionFor(evaluatorOutputContract)`. Tells the AI to write exactly one
   * file (`signals.json`) matching the documented shape.
   */
  readonly outputContractSection: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress` section so the
   * reviewer can judge this round's work against what already shipped on the sprint. Empty
   * string when the journal file is absent — the template's surrounding prose handles the
   * empty case without a per-flow special branch.
   */
  readonly priorProgress: string;
  /**
   * Optional same-round generator observations — proposed commit subject, environment notes,
   * learnings. Rendered inside a `<generator_hints>` block that explicitly frames these as
   * unverified claims: useful for environment context (e.g. dev-server port), never as
   * evidence. Empty string when no hints were collected — template collapses cleanly.
   */
  readonly generatorHintsSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const evaluatePromptDef: PromptDefinition<EvaluatePromptParams> = {
  templateName: 'evaluate',
  description:
    'Independent code review of a completed task. The agent runs deterministic checks, scores four floor dimensions, and emits one verdict signal.',
  parameters: {
    taskName: {
      placeholder: 'TASK_NAME',
      description: 'Task display name — used as the page title and inside the task-specification block.',
      validate: requireNonEmpty('taskName', 'task name must not be empty'),
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
    extraDimensionsSection: {
      placeholder: 'EXTRA_DIMENSIONS_SECTION',
      description: 'Optional task-specific dimensions block appended after the floor dimensions.',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the evaluator contract — instructs the AI to write `signals.json` directly.',
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description:
        'Current body of `progress.md` substituted into the `## Prior progress` section — empty when the journal has no entries yet.',
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
  // The single `evaluation` signal type covers both PASS and FAIL verdicts. The verdict +
  // per-dimension findings + optional critique are encoded as fields on the signal object;
  // there is no second signal type for the failure case.
  expectedSignals: ['evaluation'],
};

export interface BuildEvaluatePromptInput {
  readonly task: Task;
  readonly projectPath: string;
  /** Absolute path to the per-task `contract.md` sidecar (written by `build-task-workspace`). */
  readonly contractPath: string;
  readonly verifyScript?: string;
  readonly projectTooling?: string;
  /**
   * Pre-rendered audit-[09] output contract section. The leaf composes this via
   * `renderContractSectionFor(evaluatorOutputContract)` before calling the builder.
   */
  readonly outputContractSection: string;
  /**
   * Current `progress.md` body — inlined into the prompt's "## Prior progress" section so the
   * reviewer can judge this round's work against what already shipped. Defaults to the empty
   * string when omitted (test fixtures); production leaves always read the on-disk body.
   */
  readonly priorProgress?: string;
  /**
   * Same-round generator observations to thread to the evaluator as environment hints. These
   * are framed explicitly as unverified claims — useful for environment context (e.g. which
   * dev-server port to target for e2e), never as evidence substituting the evaluator's own run.
   * Omitted or empty → `{{GENERATOR_HINTS_SECTION}}` collapses cleanly.
   */
  readonly generatorHints?: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 * The chain leaf consumes this via function injection. `task.extraDimensions` is threaded into
 * the rubric automatically; the rendered section is empty when the field is unset.
 *
 * The template includes a `<reasoning_protocol>` section instructing the evaluator to write its
 * step-by-step assessment inside `<evaluation_thinking>` tags before emitting the verdict signal.
 * This approximates the think-tool effect via prompt engineering — research (TIDE/τ-Bench) shows
 * a 57% improvement on sequential decision chains when models externalise intermediate reasoning
 * before committing to output.
 */
export const buildEvaluatePrompt = async (
  deps: TemplateLoader,
  input: BuildEvaluatePromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, evaluatePromptDef, {
    taskName: input.task.name,
    projectPath: input.projectPath,
    contractPath: input.contractPath,
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    taskStepsSection: renderTaskStepsSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    verifyScriptSection: renderVerifyScriptSection(input.verifyScript),
    projectTooling: renderProjectToolingSection(input.projectTooling),
    extraDimensionsSection: renderExtraDimensionsSection(input.task.extraDimensions),
    outputContractSection: input.outputContractSection,
    priorProgress: input.priorProgress ?? '',
    generatorHintsSection: renderGeneratorHintsSection(input.generatorHints),
  });
