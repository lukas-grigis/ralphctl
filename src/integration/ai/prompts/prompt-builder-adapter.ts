import { join } from 'node:path';

import type { BuildOnboardPromptInput, PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import { TASK_IMPORT_JSON_SCHEMA } from '@src/business/usecases/plan/plan-schema.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { detectProjectTooling } from '@src/integration/external/project-tooling.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { assertFullySubstituted, substitute } from './placeholder-substitution.ts';
import { CHECK_GATE_EXAMPLE, loadHarnessAndSignals, loadPlannerPartials } from './prompt-partials-loader.ts';
import {
  collectAffectedRepoPaths,
  renderCheckScriptSection,
  renderCompletedTasks,
  renderDoneCriteriaSection,
  renderEvaluateWorkspaceSection,
  renderExistingAgentsMd,
  renderIssueContextSection,
  renderPlanContext,
  renderRepositories,
  renderTicket,
} from './prompt-renderers.ts';
import { TEMPLATE_NAMES } from './prompt-template-names.ts';
import type { TemplateLoader } from './template-loader.ts';

// Re-exported so tests + tooling can import TEMPLATE_NAMES from this file
// without knowing about the internal split.
export { TEMPLATE_NAMES };

/**
 * `TextPromptBuilderAdapter` — implements {@link PromptBuilderPort} on top
 * of a {@link TemplateLoader} + the `substitute` helper.
 *
 * Each builder method:
 *  1. Loads the right template via the injected loader.
 *  2. Constructs a placeholder map from the typed input bag.
 *  3. Calls `substitute`, then `assertFullySubstituted` — fail-loud on
 *     any leftover `{{TOKEN}}` so a missing field surfaces as a typed
 *     error instead of silently leaking a literal placeholder to Claude.
 *  4. Returns `Result.ok(prompt)` on success.
 *
 * The fail-loud assertion is non-negotiable — the harness's contract is
 * "every prompt is fully filled out before reaching the AI." A regression
 * here is a production-visible bug; the assertion makes it a test-time
 * one instead.
 */
export class TextPromptBuilderAdapter implements PromptBuilderPort {
  constructor(private readonly loader: TemplateLoader) {}

  async buildRefinePrompt(input: {
    ticket: Ticket;
    outputFilePath?: string;
    issueContext?: string;
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.refine);
    if (!tpl.ok) return Result.error(tpl.error);
    const rendered = substitute(tpl.value, {
      TICKET: renderTicket(input.ticket),
      // Prefer the caller-supplied (pre-fetched) issue context; fall
      // back to the bare-link rendering when no fetch was performed
      // (no link, fetch failed, or fetch turned up empty).
      ISSUE_CONTEXT: renderIssueContextSection(input.ticket, input.issueContext),
      // Interactive mode pins the output file; headless mode leaves it
      // empty so the prompt's "Write to: " line still parses.
      OUTPUT_FILE: input.outputFilePath ?? '',
    });
    const fence = assertFullySubstituted(rendered, 'buildRefinePrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildPlanPrompt(input: {
    sprint: Sprint;
    existingTasks: readonly Task[];
    outputFilePath?: string;
  }): Promise<Result<string, StorageError>> {
    // Route to the right outer template. Interactive uses
    // `plan-interactive.md` (with {{OUTPUT_FILE}}); headless uses
    // `plan-auto.md` (no output file — Claude emits JSON on stdout).
    const interactive = input.outputFilePath !== undefined && input.outputFilePath !== '';
    const outerName = interactive ? TEMPLATE_NAMES.planInteractive : TEMPLATE_NAMES.planAuto;

    const outerTpl = await this.loader.load(outerName);
    if (!outerTpl.ok) return Result.error(outerTpl.error);

    // Project tooling detected union-wise across every repo touched by
    // the sprint's tickets. The planner needs the full picture before
    // generating tasks.
    const repoPaths = collectAffectedRepoPaths(input.sprint);
    const tooling = await detectProjectTooling(repoPaths);

    // The four planner partials Claude expects to see embedded.
    const partialsResult = await loadPlannerPartials(this.loader, tooling.rendered);
    if (!partialsResult.ok) return Result.error(partialsResult.error);
    const { harness, common, validation, signals } = partialsResult.value;

    // CONTEXT — sprint metadata + tickets with their refined requirements
    // + existing tasks (replan signal). This is what 0.5.0 called
    // `buildSprintContext`. Without it Claude has nothing to plan against.
    const context = renderPlanContext(input.sprint, input.existingTasks);

    const subs: Record<string, string> = {
      HARNESS_CONTEXT: harness,
      COMMON: common,
      VALIDATION: validation,
      SIGNALS: signals,
      CHECK_GATE_EXAMPLE,
      CONTEXT: context,
      SCHEMA: TASK_IMPORT_JSON_SCHEMA,
      OUTPUT_FILE: input.outputFilePath ?? '',
    };

    const rendered = substitute(outerTpl.value, subs);
    const fence = assertFullySubstituted(rendered, 'buildPlanPrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.ideate);
    if (!tpl.ok) return Result.error(tpl.error);

    // Ideate is "refine + plan in one shot" — the AI is expected to emit
    // a `<ticket>` block and a planner-shaped `<tasks>` array. The
    // template embeds the same partials as the planner: harness context,
    // plan-common (with examples + check-gate pre-substituted),
    // validation checklist, and the planning signal vocabulary.
    //
    // PROJECT_TOOLING is rendered union-wise across affected repos so
    // the planner sees the full tooling picture, mirroring buildPlanPrompt.
    const repoPaths = collectAffectedRepoPaths(input.sprint);
    const tooling = await detectProjectTooling(repoPaths);

    const partialsResult = await loadPlannerPartials(this.loader, tooling.rendered);
    if (!partialsResult.ok) return Result.error(partialsResult.error);
    const { harness, common, validation, signals } = partialsResult.value;

    const repositories = renderRepositories(input.sprint);
    const rendered = substitute(tpl.value, {
      IDEA_TITLE: input.sprint.name,
      IDEA_DESCRIPTION: input.ideaText,
      PROJECT_NAME: String(input.sprint.projectName),
      REPOSITORIES: repositories,
      HARNESS_CONTEXT: harness,
      COMMON: common,
      VALIDATION: validation,
      SIGNALS: signals,
      CHECK_GATE_EXAMPLE,
      // Ideate currently runs headless — the AI emits the JSON in a
      // `<tasks>` block on stdout instead of writing to a file. If
      // interactive mode lands later, thread an `outputFilePath` opt
      // through and substitute it here.
      OUTPUT_FILE: '',
      // Ideate's task array shape is identical to the planner's; no
      // need to invent a parallel schema. The `<ticket>` block lives
      // outside the JSON and is parsed via regex (see
      // `IdeateAndPlanUseCase.extractTicketParts`).
      SCHEMA: TASK_IMPORT_JSON_SCHEMA,
    });
    const fence = assertFullySubstituted(rendered, 'buildIdeatePrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildExecutePrompt(input: {
    task: Task;
    sprint: Sprint;
    checkScript?: string;
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.execute);
    if (!tpl.ok) return Result.error(tpl.error);

    // Project tooling is detected from the task's projectPath — task
    // execution always targets exactly one repo.
    const tooling = await detectProjectTooling([input.task.projectPath]);

    // Load the harness-context + task-signals partials so the prompt
    // describes the full signal vocabulary the AI is expected to emit.
    const harnessAndSignals = await loadHarnessAndSignals(this.loader, 'task');
    if (!harnessAndSignals.ok) return Result.error(harnessAndSignals.error);

    // Progress file path — constructed from the sprint directory so the
    // agent can read accumulated task learnings from prior runs. Uses the
    // same resolveStoragePaths() helper that the signal handler uses to
    // write entries, so read and write always land on the same file.
    const storagePaths = resolveStoragePaths();
    const progressFile = join(storagePaths.sprintDir(input.sprint.id), 'progress.md');

    // Inline task-body sections — conditional renderers omit the slot
    // entirely when the source field is empty so the prompt doesn't
    // sprout orphan headers.
    const desc =
      input.task.description !== undefined && input.task.description.trim().length > 0
        ? `## Description\n\n${input.task.description.trim()}`
        : '';
    const steps =
      input.task.steps.length > 0
        ? `## Implementation Steps\n\n${input.task.steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n')}`
        : '';
    const criteria =
      input.task.verificationCriteria.length > 0
        ? `## Verification Criteria\n\n${input.task.verificationCriteria.map((c) => `- ${c}`).join('\n')}`
        : '';
    const branchLine = input.sprint.branch !== null ? `**Branch:** \`${input.sprint.branch}\`` : '';

    // Check Script section is always rendered — the "no script
    // configured" case is load-bearing, telling the AI not to chase a
    // missing command. The chain layer threads the resolved per-repo
    // `checkScript` through `PerTaskCtx.checkScript`; when present we
    // embed the actual command so the agent can run it as part of
    // verification. When absent the section reads as an explicit
    // "no check script configured" — never the old "see docs" boilerplate.
    const checkScriptSection = renderCheckScriptSection(input.checkScript);

    const setupRanAtForRepo = input.sprint.setupRanAt.get(input.task.projectPath);
    const environmentStatus =
      setupRanAtForRepo !== undefined ? `Setup script ran at ${String(setupRanAtForRepo)}.` : 'Not run.';

    const rendered = substitute(tpl.value, {
      TASK_NAME: input.task.name,
      TASK_ID: String(input.task.id),
      PROJECT_PATH: String(input.task.projectPath),
      BRANCH_LINE: branchLine,
      TASK_DESCRIPTION_SECTION: desc,
      TASK_STEPS_SECTION: steps,
      VERIFICATION_CRITERIA_SECTION: criteria,
      CHECK_SCRIPT_SECTION: checkScriptSection,
      ENVIRONMENT_STATUS: environmentStatus,
      PROGRESS_FILE: progressFile,
      HARNESS_CONTEXT: harnessAndSignals.value.harness,
      SIGNALS: harnessAndSignals.value.signals,
      // Outer-composition placeholders — empty by default; reserved for
      // future provider-specific commit / commit-constraint sections.
      COMMIT_STEP: '',
      COMMIT_CONSTRAINT: '',
      PROJECT_TOOLING: tooling.rendered,
    });
    const fence = assertFullySubstituted(rendered, 'buildExecutePrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildEvaluatePrompt(input: {
    task: Task;
    sprint: Sprint;
    previousCritique?: string;
    evaluateWorkspaceDir?: string;
    doneCriteriaBullet?: string;
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.evaluate);
    if (!tpl.ok) return Result.error(tpl.error);

    // The evaluator template references three partials. An empty
    // substitution silently emits a stray `{{HARNESS_CONTEXT}}` /
    // `{{SIGNALS}}` to the AI — `<evaluation-passed>` / `<evaluation-failed>`
    // never get described, the parser flags the output malformed, and the
    // task stays stuck in_progress.
    const harnessAndSignals = await loadHarnessAndSignals(this.loader, 'evaluation');
    if (!harnessAndSignals.ok) return Result.error(harnessAndSignals.error);

    // Project tooling is detected from the task's projectPath — the
    // evaluator runs in the same repo as the generator did.
    const tooling = await detectProjectTooling([input.task.projectPath]);

    const desc = input.task.description ? `\n**Description:** ${input.task.description}` : '';
    const steps =
      input.task.steps.length > 0
        ? `\n**Implementation Steps:**\n${input.task.steps.map((s) => `- ${s}`).join('\n')}`
        : '';
    const criteria =
      input.task.verificationCriteria.length > 0
        ? `\n**Verification Criteria:**\n${input.task.verificationCriteria.map((c) => `- ${c}`).join('\n')}`
        : '';
    const checkSection = input.previousCritique ? `\n\n**Previous Critique:**\n\n${input.previousCritique}` : '';

    const rendered = substitute(tpl.value, {
      TASK_NAME: input.task.name,
      TASK_DESCRIPTION_SECTION: desc,
      TASK_STEPS_SECTION: steps,
      VERIFICATION_CRITERIA_SECTION: criteria,
      PROJECT_PATH: input.task.projectPath,
      CHECK_SCRIPT_SECTION: checkSection,
      HARNESS_CONTEXT: harnessAndSignals.value.harness,
      SIGNALS: harnessAndSignals.value.signals,
      PROJECT_TOOLING: tooling.rendered,
      // Workspace contract section — when the per-task chain mounted
      // an evaluate workspace, embed a pointer so the evaluator reads
      // upstream artefacts (refined requirements, full task plan,
      // dimension definitions, prior sibling evaluations). Empty
      // string when no workspace (standalone `sprint evaluate`).
      EVALUATE_WORKSPACE: renderEvaluateWorkspaceSection(input.evaluateWorkspaceDir),
      // Per-task done-criteria bullet — the single line from
      // `done-criteria.md` that names the success criterion for THIS
      // task. Renders a `## Per-task done criteria` section when
      // present; collapses to '' when absent (no workspace / legacy
      // sprint / standalone evaluate).
      DONE_CRITERIA_SECTION: renderDoneCriteriaSection(input.doneCriteriaBullet),
      // Extra-dimension blocks are conditionally rendered upstream
      // (the planner emits them per-task). Empty default = floor-only.
      EXTRA_DIMENSIONS_SECTION: '',
      EXTRA_DIMENSIONS_PASS_BAR: '',
      EXTRA_DIMENSIONS_ASSESSMENT_PASS: '',
      EXTRA_DIMENSIONS_ASSESSMENT_MIXED: '',
    });
    const fence = assertFullySubstituted(rendered, 'buildEvaluatePrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildFeedbackPrompt(input: {
    sprint: Sprint;
    feedbackText: string;
    completedTasks: readonly Task[];
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.feedback);
    if (!tpl.ok) return Result.error(tpl.error);

    // Feedback applies code changes (same vocabulary as task execution),
    // so we wire the task signal partial. Without these substitutions
    // the agent sees stray `{{HARNESS_CONTEXT}}` / `{{SIGNALS}}` and
    // doesn't know how to signal `<task-verified>` / `<task-complete>`.
    const harnessAndSignals = await loadHarnessAndSignals(this.loader, 'task');
    if (!harnessAndSignals.ok) return Result.error(harnessAndSignals.error);

    const branchSection = input.sprint.branch ? `\n**Branch:** ${input.sprint.branch}\n` : '';
    const rendered = substitute(tpl.value, {
      SPRINT_NAME: input.sprint.name,
      BRANCH_SECTION: branchSection,
      COMPLETED_TASKS: renderCompletedTasks(input.completedTasks),
      FEEDBACK: input.feedbackText,
      HARNESS_CONTEXT: harnessAndSignals.value.harness,
      SIGNALS: harnessAndSignals.value.signals,
    });
    const fence = assertFullySubstituted(rendered, 'buildFeedbackPrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }

  async buildOnboardPrompt(input: BuildOnboardPromptInput): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.onboard);
    if (!tpl.ok) return Result.error(tpl.error);
    const rendered = substitute(tpl.value, {
      REPO_PATH: input.repoPath,
      FILE_NAME: input.fileName,
      MODE: input.mode,
      PROJECT_TYPE: input.projectType,
      CHECK_SCRIPT_SUGGESTION: input.checkScriptSuggestion ?? '',
      EXISTING_AGENTS_MD: renderExistingAgentsMd(input.existingAgentsMd),
    });
    const fence = assertFullySubstituted(rendered, 'buildOnboardPrompt');
    if (!fence.ok) return Result.error(fence.error);
    return Result.ok(rendered);
  }
}
