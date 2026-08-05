import { type Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { buildPrompt, type BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import {
  renderProjectToolingSection,
  renderTaskDescriptionSection,
  renderVerificationCriteriaSection,
} from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { requireNonEmpty } from '@src/integration/ai/prompts/_engine/validators.ts';

/**
 * `reproduce` prompt: one-shot session that runs before the generator turn on a defect-shaped
 * task. It understands the reported defect, locates the most relevant existing tests, writes ONE
 * new failing test that demonstrates the defect exactly as reported, runs it to capture the
 * failure, and reports via `signals.json` — it does NOT fix anything. Sibling of `detect-scripts`
 * in shape (slim, task-focused rather than full implement): task description / criteria, project
 * tooling, prior progress, output contract.
 *
 * Research grounding (ORACLE-SWE, arXiv 2604.07789): reproduction tests are the dominant single
 * planning factor for defect-shaped tasks — the paper's headline SWE-bench Live figure (Claude
 * 4.5: 40% → 83%) is oracle-injected, not what a harness session can produce; the
 * harness-implementable arm is the agent-extracted validation, where a stronger-extraction /
 * weaker-fix pairing beats the strong model alone (Live: 54% vs 46%). TestPrune (FSE 2026) shows
 * a cheap issue-relevant test subset lifts resolution 8-12.9% relative — the `relevantTests`
 * field this session reports feeds that.
 */
export interface ReproducePromptParams {
  /** Task display name — `{{TASK_NAME}}` (the level-1 heading body in the rendered prompt). */
  readonly taskName: string;
  /** Absolute project path the task targets — `{{PROJECT_PATH}}`. */
  readonly projectPath: string;
  /** Markdown block "## Description\n\n…" or empty when the task has no description. */
  readonly taskDescriptionSection: string;
  /** Markdown block "## Done criteria\n\n- …" or empty when there are none. */
  readonly verificationCriteriaSection: string;
  /** Detected subagents / skills / MCP servers the session can route to, or fallback. */
  readonly projectTooling: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress` section. Empty
   * string when the journal file is absent — the template's surrounding prose handles the
   * empty case without a special branch.
   */
  readonly priorProgress: string;
  /**
   * Audit-[09] output contract section — rendered from the reproduce `AiOutputContract` by
   * `renderContractSectionFor(reproduceOutputContract)`. Tells the AI to write `signals.json`
   * with exactly one `reproduction` signal and an optional `note`.
   */
  readonly outputContractSection: string;
}

export const reproducePromptDef: PromptDefinition<ReproducePromptParams> = {
  templateName: 'reproduce',
  description:
    'One-shot reproduction of a reported defect. The session writes and runs ONE failing test demonstrating the defect exactly as reported — it does not fix anything.',
  parameters: {
    taskName: {
      placeholder: 'TASK_NAME',
      description: 'Task display name — used as the level-1 heading.',
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
    verificationCriteriaSection: {
      placeholder: 'VERIFICATION_CRITERIA_SECTION',
      description: '"## Done criteria" bullet list, or empty when none are declared.',
    },
    projectTooling: {
      placeholder: 'PROJECT_TOOLING',
      description: 'Detected subagents, skills, MCP servers, or "(none detected)".',
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description:
        'Current body of `progress.md` substituted into the `## Prior progress` section — empty when the journal has no entries yet.',
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the reproduce contract — instructs the AI to write `signals.json` directly.',
      validate: requireNonEmpty(
        'outputContractSection',
        'output-contract section must not be empty (renderContractSectionFor always emits a body)'
      ),
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
  },
  expectedSignals: ['reproduction', 'note'],
};

export interface BuildReproducePromptInput {
  readonly task: Task;
  readonly projectPath: string;
  readonly projectTooling?: string;
  /** Current `progress.md` body — inlined into the prompt's "## Prior progress" section. */
  readonly priorProgress?: string;
  /**
   * Pre-rendered audit-[09] output contract section. The leaf composes this via
   * `renderContractSectionFor(reproduceOutputContract)` before calling the builder.
   */
  readonly outputContractSection: string;
}

/**
 * Top-level builder — accepts domain types, renders the param strings, calls `buildPrompt`.
 */
export const buildReproducePrompt = async (
  deps: TemplateLoader,
  input: BuildReproducePromptInput
): Promise<Result<Prompt, BuildPromptError>> =>
  buildPrompt(deps, reproducePromptDef, {
    taskName: input.task.name,
    projectPath: input.projectPath,
    taskDescriptionSection: renderTaskDescriptionSection(input.task),
    verificationCriteriaSection: renderVerificationCriteriaSection(input.task),
    projectTooling: renderProjectToolingSection(input.projectTooling),
    priorProgress: input.priorProgress ?? '',
    outputContractSection: input.outputContractSection,
  });
