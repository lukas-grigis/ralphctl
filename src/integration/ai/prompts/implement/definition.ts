import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderCheckScriptSection,
  renderPriorCritiqueSection,
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

// Re-export the shared task renderers from this module so consumers (and tests) that already
// import them from `definitions/implement.ts` keep working after the lift to
// `renderers/task.ts`. The originals lived here historically; the actual implementations are
// now in the shared module.
export {
  renderCheckScriptSection,
  renderPriorCritiqueSection,
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderTaskStepsSection,
  renderVerificationCriteriaSection,
};

/**
 * Pre-rendered string parameters for the implement template. The renderer helpers below
 * produce each block from domain types; callers can also build the strings by hand for tests.
 *
 * The implement template tells one task implementer agent how to execute a single
 * pre-planned task: read the description / steps / verification criteria, run the check
 * script as the post-task gate, append a learnings entry to the progress file, then signal
 * completion. Every slot below is a typed string the chain leaf renders before calling
 * `buildPrompt`.
 */
export interface ImplementPromptParams {
  /** Task display name — `{{TASK_NAME}}` (the level-1 heading body in the rendered prompt). */
  readonly taskName: string;
  /** Task id rendered as a string — `{{TASK_ID}}`. */
  readonly taskId: string;
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
  /** Detected subagents / skills / MCP servers the implementer can route to, or fallback. */
  readonly projectTooling: string;
  /** Absolute path to `progress.md` for this sprint — `{{PROGRESS_FILE}}`. */
  readonly progressFile: string;
  /**
   * Markdown body for "## Prior Critique" — empty on turn 1, populated on every subsequent
   * turn of the gen-eval loop with the failed evaluator critique from the previous turn so
   * the generator's fix attempt addresses the same dimensions the evaluator flagged.
   */
  readonly priorCritiqueSection: string;
}

const requireNonEmpty =
  (field: string, message: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0 ? Result.error(new ValidationError({ field, value: v, message })) : Result.ok(v);

export const implementPromptDef: PromptDefinition<ImplementPromptParams> = {
  templateName: 'implement',
  description:
    'One-shot task execution. The agent reads the task body, runs the check script, appends a progress entry, and emits harness signals.',
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
    progressFile: {
      placeholder: 'PROGRESS_FILE',
      description: 'Absolute path to the sprint progress.md file the implementer appends to.',
      validate: requireNonEmpty('progressFile', 'progress file path must not be empty'),
    },
    priorCritiqueSection: {
      placeholder: 'PRIOR_CRITIQUE_SECTION',
      description: '"## Prior Critique" markdown block — empty on turn 1, the evaluator\'s failed critique on turn 2+.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    SIGNALS: 'signals-task',
  },
  // Documents the harness signals the implement response is expected to carry. Validation is
  // not enforced at parse time — this list drives test authors and future scoped parsers.
  expectedSignals: ['progress', 'note', 'task-verified', 'task-complete', 'task-blocked', 'commit-message'],
};

export interface BuildImplementPromptInput {
  readonly task: Task;
  readonly projectPath: string;
  readonly checkScript?: string;
  readonly progressFile: string;
  readonly projectTooling?: string;
  /**
   * Prior evaluator critique to feed back into the generator on turn 2+. Absent on turn 1
   * (no prior critique yet). The chain leaf reads the running attempt's `critique` field —
   * populated by the previous evaluator turn — and threads it through here so the generator
   * fix attempt sees the same dimensions the evaluator graded last.
   */
  readonly priorCritique?: string;
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
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    taskStepsSection: renderTaskStepsSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    checkScriptSection: renderCheckScriptSection(input.checkScript),
    projectTooling: renderProjectToolingSection(input.projectTooling),
    progressFile: input.progressFile,
    priorCritiqueSection: renderPriorCritiqueSection(input.priorCritique),
  });
