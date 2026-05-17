import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderCheckScriptSection,
  renderExtraDimensionsSection,
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Pre-rendered string parameters for the evaluate template. Mirrors the implement
 * definition's task-shaped slots — the evaluator reviews the same task spec the implementer
 * just executed against — but omits the implementer-specific identifiers (TASK_ID,
 * PROGRESS_FILE) and uses the `signals-evaluation` partial instead of `signals-task`.
 *
 * The evaluate template runs an independent reviewer agent: it reads the task description /
 * steps / verification criteria, runs the check script as authoritative ground truth, scores
 * four floor dimensions (correctness, completeness, safety, consistency), and emits exactly
 * one verdict signal — `<evaluation-passed>` or `<evaluation-failed>critique</evaluation-failed>`.
 */
export interface EvaluatePromptParams {
  /** Task display name — `{{TASK_NAME}}` (referenced both as the page title and inside the spec block). */
  readonly taskName: string;
  /** Absolute project path the task targets — `{{PROJECT_PATH}}`. */
  readonly projectPath: string;
  /** Markdown block "## Description\n\n…" or empty when the task has no description. */
  readonly taskDescriptionSection: string;
  /** Markdown block "## Implementation Steps\n\n1. …" or empty when there are no steps. */
  readonly taskStepsSection: string;
  /** Markdown block "## Verification Criteria\n\n- …" or empty when there are none. */
  readonly verificationCriteriaSection: string;
  /**
   * Markdown body for the "## Check Script" section — either a fenced shell block with the
   * configured command or the explicit "no check script configured" line. Always non-empty.
   */
  readonly checkScriptSection: string;
  /** Detected subagents / skills / MCP servers the reviewer can route to, or fallback. */
  readonly projectTooling: string;
  /**
   * Optional "Task-specific dimensions" block appended after the four floor dimensions. Empty
   * string when the planner didn't attach extras to this task — keeps the template stable.
   */
  readonly extraDimensionsSection: string;
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
      description: '"## Verification Criteria" bullet list, or empty when none are declared.',
    },
    checkScriptSection: {
      placeholder: 'CHECK_SCRIPT_SECTION',
      description:
        'Body of the "## Check Script" section — fenced shell block when configured, explicit "no check script configured" otherwise.',
      validate: requireNonEmpty(
        'checkScriptSection',
        'check-script section must not be empty (renderCheckScriptSection always emits a body)'
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
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    SIGNALS: 'signals-evaluation',
  },
  // The single `evaluation` signal type covers both verdict shapes (`<evaluation-passed>` and
  // `<evaluation-failed>critique</evaluation-failed>`). The body / critique distinction is
  // handled inside the parsed signal, not by a second tag.
  expectedSignals: ['evaluation'],
};

export interface BuildEvaluatePromptInput {
  readonly task: Task;
  readonly projectPath: string;
  readonly checkScript?: string;
  readonly projectTooling?: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 * The chain leaf consumes this via function injection. `task.extraDimensions` is threaded into
 * the rubric automatically; the rendered section is empty when the field is unset.
 */
export const buildEvaluatePrompt = async (
  deps: TemplateLoader,
  input: BuildEvaluatePromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, evaluatePromptDef, {
    taskName: input.task.name,
    projectPath: input.projectPath,
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    taskStepsSection: renderTaskStepsSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    checkScriptSection: renderCheckScriptSection(input.checkScript),
    projectTooling: renderProjectToolingSection(input.projectTooling),
    extraDimensionsSection: renderExtraDimensionsSection(input.task.extraDimensions),
  });
