import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { composeCriteriaHistory } from '@src/business/task/compose-criteria-history.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import { renderFloorRubricSection } from '@src/integration/ai/prompts/_engine/renderers/floor-rubric.ts';
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
 * five floor dimensions (correctness, completeness, safety, consistency, robustness), and writes
 * exactly one `evaluation` signal to `signals.json` carrying the PASS / FAIL verdict +
 * per-dimension findings.
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
   * Rendered `{{FLOOR_RUBRIC_SECTION}}` markdown block — the five floor dimensions, each with a
   * rationale-before-verdict block, single-sourced from `FLOOR_DIMENSIONS` via
   * {@link renderFloorRubricSection}. Always non-empty.
   */
  readonly floorRubricSection: string;
  /**
   * Optional "Task-specific dimensions" block appended after the five floor dimensions. Empty
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
  /**
   * "## Prior criteria verdicts" block — the durable per-criterion k-of-N checklist carried across
   * rounds (`Task.criteriaVerdicts`), rendered by `composeCriteriaHistory`. Surfaced so the reviewer
   * knows the checklist is multi-round rather than a fresh binary; the surrounding template prose
   * frames it as context that must still be re-verified independently, never carried forward as a
   * PASS. Empty (no criterion graded yet) → `{{PRIOR_CRITERIA_VERDICTS}}` collapses cleanly.
   * Optional so direct `buildPrompt` callers (test fixtures) may omit it; `buildEvaluatePrompt`
   * always supplies it (empty string when there is no history).
   */
  readonly priorCriteriaVerdictsSection?: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const evaluatePromptDef: PromptDefinition<EvaluatePromptParams> = {
  templateName: 'evaluate',
  description:
    'Independent code review of a completed task. The agent runs deterministic checks, scores five floor dimensions, and emits one verdict signal.',
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
    floorRubricSection: {
      placeholder: 'FLOOR_RUBRIC_SECTION',
      description:
        'The five floor dimensions, each rendered as a rationale-before-verdict block, single-sourced from FLOOR_DIMENSIONS.',
      validate: requireNonEmpty(
        'floorRubricSection',
        'floor-rubric section must not be empty (renderFloorRubricSection always emits a body)'
      ),
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
    priorCriteriaVerdictsSection: {
      placeholder: 'PRIOR_CRITERIA_VERDICTS',
      optional: true,
      description:
        'Durable per-criterion k-of-N checklist carried across rounds (`Task.criteriaVerdicts`), rendered ' +
        'by `composeCriteriaHistory`. Context only — re-verify independently. Empty → `{{PRIOR_CRITERIA_VERDICTS}}` collapses.',
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
 * The template follows a four-phase protocol. Phase 0 writes a placeholder `signals.json`
 * immediately as a recovery checkpoint — if the session exhausts its token budget mid-analysis the
 * harness can prompt a cheaper follow-up rather than restarting from scratch. Phase 1 runs
 * deterministic checks: each `auto` criterion's command directly (not the verify script). Phase 2
 * grades every criterion and records each verdict structurally in the `evaluation` signal's `criteria`
 * array (id + passed boolean + one-line evidence citation) in addition to prose assessment. Phase 3
 * applies inferential investigation to what deterministic checks cannot catch, including end-to-end
 * product exercise when a run-path is declared in `<project_tooling>`. Phase 4 assesses the five
 * floor dimensions (correctness, completeness, safety, consistency, robustness) rendered via
 * `{{FLOOR_RUBRIC_SECTION}}`, plus any task-specific extras injected via
 * `{{EXTRA_DIMENSIONS_SECTION}}`. An `<evaluation_discipline>` block instructs the
 * evaluator to work through each criterion and floor dimension explicitly — recording a preliminary
 * verdict per criterion before moving to the next — to reduce premature verdict commitment.
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
    floorRubricSection: renderFloorRubricSection(),
    extraDimensionsSection: renderExtraDimensionsSection(input.task.extraDimensions),
    outputContractSection: input.outputContractSection,
    priorProgress: input.priorProgress ?? '',
    generatorHintsSection: renderGeneratorHintsSection(input.generatorHints),
    // Derived from the task itself (the durable per-criterion verdict map is a task field), so no
    // leaf needs to pre-compose or thread it. Empty (no criterion graded yet) → collapses.
    priorCriteriaVerdictsSection: composeCriteriaHistory({
      verificationCriteria: input.task.verificationCriteria,
      verdicts: input.task.criteriaVerdicts,
    }),
  });
