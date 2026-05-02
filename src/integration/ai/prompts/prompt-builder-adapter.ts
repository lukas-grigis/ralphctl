import type { BuildOnboardPromptInput, PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import { TASK_IMPORT_JSON_SCHEMA } from '@src/business/usecases/plan/plan-schema.ts';
import { REFINED_REQUIREMENTS_JSON_SCHEMA } from '@src/business/usecases/refine/refinement-schema.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { detectProjectTooling } from '@src/integration/external/project-tooling.ts';
import { substitute } from './placeholder-substitution.ts';
import type { TemplateLoader } from './template-loader.ts';

/**
 * Mapping from each `PromptBuilderPort` method to its source `.md`
 * template. Re-exported so tests + tooling can verify the wiring without
 * reaching into private fields.
 */
export const TEMPLATE_NAMES = {
  refine: 'ticket-refine',
  plan: 'plan-common',
  // Outer plan templates — picked by `interactive` flag at build time.
  planInteractive: 'plan-interactive',
  planAuto: 'plan-auto',
  // Shared partials embedded by the planner.
  planCommon: 'plan-common',
  planCommonExamples: 'plan-common-examples',
  harnessContext: 'harness-context',
  validationChecklist: 'validation-checklist',
  signalsPlanning: 'signals-planning',
  ideate: 'ideate',
  ideateAuto: 'ideate-auto',
  execute: 'task-execution',
  evaluate: 'task-evaluation',
  feedback: 'sprint-feedback',
  onboard: 'repo-onboard',
} as const;

/**
 * Neutral, ecosystem-agnostic check-gate example. Pre-expanded inside
 * the planner partials so generated `steps` / `verificationCriteria`
 * examples don't leak Node-specific commands (`pnpm test`) to prompts
 * that run in Python / Go / Rust / Java / mixed repos. Downstream
 * projects supply the real command via `{{PROJECT_TOOLING}}` at runtime.
 */
const CHECK_GATE_EXAMPLE =
  "Run the project's check gate — all pass (omit this step when the project has no check script)";

/**
 * `TextPromptBuilderAdapter` — implements {@link PromptBuilderPort} on top
 * of a {@link TemplateLoader} + the `substitute` helper.
 *
 * Each builder method:
 *  1. Loads the right template via the injected loader.
 *  2. Constructs a placeholder map from the typed input bag.
 *  3. Calls `substitute` and returns `Result.ok(prompt)` — never throws.
 *
 * Adapters intentionally only fill the placeholders they can derive from
 * the input bag. The substitution layer is fail-soft: unknown
 * placeholders are left intact so a future enrichment step (e.g. a
 * "tooling section" producer) can layer additional substitution on top
 * without forcing the port to grow.
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
    return Result.ok(
      substitute(tpl.value, {
        TICKET: renderTicket(input.ticket),
        // Prefer the caller-supplied (pre-fetched) issue context; fall
        // back to the bare-link rendering when no fetch was performed
        // (no link, fetch failed, or fetch turned up empty).
        ISSUE_CONTEXT: renderIssueContextSection(input.ticket, input.issueContext),
        // Interactive mode pins the output file; headless mode leaves it
        // empty so the prompt's "Write to: " line still parses.
        OUTPUT_FILE: input.outputFilePath ?? '',
        // The schema is what tells Claude how to format the JSON it
        // writes (or emits to stdout). Without this the AI invents a
        // shape and the parser falls back to the raw-body path.
        SCHEMA: REFINED_REQUIREMENTS_JSON_SCHEMA,
      })
    );
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
    const partialsResult = await this.loadPlannerPartials(tooling.rendered);
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
    };
    if (interactive) {
      subs['OUTPUT_FILE'] = input.outputFilePath ?? '';
    }

    return Result.ok(substitute(outerTpl.value, subs));
  }

  /**
   * Load the four planner partials and pre-substitute their inner
   * placeholders so they drop cleanly into the outer plan template. The
   * `plan-common.md` partial nests `{{PLAN_COMMON_EXAMPLES}}`,
   * `{{PROJECT_TOOLING}}` and `{{CHECK_GATE_EXAMPLE}}` — those have to be
   * resolved before `COMMON` is itself substituted into the outer
   * template, otherwise we get unresolved tokens reaching the AI.
   */
  private async loadPlannerPartials(
    projectToolingSection: string
  ): Promise<Result<{ harness: string; common: string; validation: string; signals: string }, StorageError>> {
    const [harness, planCommon, planExamples, validation, signals] = await Promise.all([
      this.loader.load(TEMPLATE_NAMES.harnessContext),
      this.loader.load(TEMPLATE_NAMES.planCommon),
      this.loader.load(TEMPLATE_NAMES.planCommonExamples),
      this.loader.load(TEMPLATE_NAMES.validationChecklist),
      this.loader.load(TEMPLATE_NAMES.signalsPlanning),
    ]);
    for (const r of [harness, planCommon, planExamples, validation, signals]) {
      if (!r.ok) return Result.error(r.error);
    }
    if (!harness.ok || !planCommon.ok || !planExamples.ok || !validation.ok || !signals.ok) {
      return Result.error(
        new StorageError({ subCode: 'io', message: 'failed to load planner partials (defensive guard)' })
      );
    }
    // The examples partial has its own {{CHECK_GATE_EXAMPLE}} marker.
    // `substitute` is a single regex pass, so any placeholder inside an
    // injected value is NOT re-scanned. Pre-substitute the examples
    // before they land in plan-common, otherwise the outer prompt emits
    // a literal {{CHECK_GATE_EXAMPLE}} to Claude.
    const examplesResolved = substitute(planExamples.value, { CHECK_GATE_EXAMPLE });
    const common = substitute(planCommon.value, {
      PLAN_COMMON_EXAMPLES: examplesResolved,
      PROJECT_TOOLING: projectToolingSection,
      CHECK_GATE_EXAMPLE,
    });
    return Result.ok({
      harness: harness.value,
      common,
      validation: validation.value,
      signals: signals.value,
    });
  }

  async buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.ideate);
    if (!tpl.ok) return Result.error(tpl.error);
    const repositories = renderRepositories(input.sprint);
    return Result.ok(
      substitute(tpl.value, {
        IDEA_TITLE: input.sprint.name,
        IDEA_DESCRIPTION: input.ideaText,
        PROJECT_NAME: String(input.sprint.projectName),
        REPOSITORIES: repositories,
        // Outer-composition placeholders — left empty.
        HARNESS_CONTEXT: '',
        COMMON: '',
        VALIDATION: '',
        SIGNALS: '',
        CHECK_GATE_EXAMPLE: '',
        OUTPUT_FILE: '',
        SCHEMA: '',
      })
    );
  }

  async buildExecutePrompt(input: { task: Task; sprint: Sprint }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.execute);
    if (!tpl.ok) return Result.error(tpl.error);

    // Project tooling is detected from the task's projectPath — task
    // execution always targets exactly one repo.
    const tooling = await detectProjectTooling([input.task.projectPath]);

    return Result.ok(
      substitute(tpl.value, {
        // Task-execution prompt expects HARNESS_CONTEXT/SIGNALS as
        // upstream-built partials and PROGRESS_FILE/CONTEXT_FILE/etc.
        // as caller-controlled paths.
        HARNESS_CONTEXT: '',
        SIGNALS: '',
        PROGRESS_FILE: '',
        CONTEXT_FILE: '',
        COMMIT_STEP: '',
        COMMIT_CONSTRAINT: '',
        PROJECT_TOOLING: tooling.rendered,
      })
    );
  }

  async buildEvaluatePrompt(input: {
    task: Task;
    sprint: Sprint;
    previousCritique?: string;
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.evaluate);
    if (!tpl.ok) return Result.error(tpl.error);

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

    return Result.ok(
      substitute(tpl.value, {
        TASK_NAME: input.task.name,
        TASK_DESCRIPTION_SECTION: desc,
        TASK_STEPS_SECTION: steps,
        VERIFICATION_CRITERIA_SECTION: criteria,
        PROJECT_PATH: input.task.projectPath,
        CHECK_SCRIPT_SECTION: checkSection,
        // Outer-composition placeholders — empty.
        HARNESS_CONTEXT: '',
        SIGNALS: '',
        PROJECT_TOOLING: '',
        EXTRA_DIMENSIONS_SECTION: '',
        EXTRA_DIMENSIONS_PASS_BAR: '',
        EXTRA_DIMENSIONS_ASSESSMENT_PASS: '',
        EXTRA_DIMENSIONS_ASSESSMENT_MIXED: '',
      })
    );
  }

  async buildFeedbackPrompt(input: { sprint: Sprint; feedbackText: string }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.feedback);
    if (!tpl.ok) return Result.error(tpl.error);
    const branchSection = input.sprint.branch ? `\n**Branch:** ${input.sprint.branch}\n` : '';
    return Result.ok(
      substitute(tpl.value, {
        SPRINT_NAME: input.sprint.name,
        BRANCH_SECTION: branchSection,
        COMPLETED_TASKS: '',
        FEEDBACK: input.feedbackText,
        HARNESS_CONTEXT: '',
        SIGNALS: '',
      })
    );
  }

  async buildOnboardPrompt(input: BuildOnboardPromptInput): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.onboard);
    if (!tpl.ok) return Result.error(tpl.error);
    return Result.ok(
      substitute(tpl.value, {
        REPO_PATH: input.repoPath,
        FILE_NAME: input.fileName,
        MODE: input.mode,
        PROJECT_TYPE: input.projectType,
        CHECK_SCRIPT_SUGGESTION: input.checkScriptSuggestion ?? '',
        EXISTING_AGENTS_MD: renderExistingAgentsMd(input.existingAgentsMd),
      })
    );
  }
}

// ───────────────────────── pure renderers ─────────────────────────

function renderTicket(ticket: Ticket): string {
  // Project is sprint-level context after sprint-per-project — we no longer
  // re-state it per ticket. The refine prompt is implementation-agnostic
  // and doesn't need to know which project the ticket lives in.
  const lines: string[] = [`**Title:** ${ticket.title}`, `**ID:** ${ticket.id}`];
  if (ticket.link !== undefined) lines.push(`**Link:** ${ticket.link}`);
  if (ticket.description !== undefined) {
    lines.push('', '**Description:**', '', ticket.description);
  }
  return lines.join('\n');
}

function renderIssueContext(ticket: Ticket): string {
  // Mirror the legacy convention: when the ticket carries an upstream
  // link, emit a canonical <context>...</context> wrapper so downstream
  // prompt readers can spot it. No link → empty section.
  return ticket.link === undefined ? '' : `<context>\n\nUpstream issue: ${ticket.link}\n\n</context>`;
}

/**
 * Pick the right `<context>...</context>` block for the prompt:
 *  - Caller-supplied `issueContext` (the chain leaf pre-fetched via
 *    `ExternalPort.fetchIssue` + `formatIssueContext`) → wrap as-is.
 *  - Otherwise fall back to the bare-link rendering (or empty when no link).
 */
function renderIssueContextSection(ticket: Ticket, issueContext: string | undefined): string {
  if (issueContext !== undefined && issueContext.trim().length > 0) {
    return `<context>\n\n${issueContext.trim()}\n\n</context>`;
  }
  return renderIssueContext(ticket);
}

function renderRepositories(sprint: Sprint): string {
  // Sprint-per-project: repos live on the sprint, not on individual
  // tickets. `sprint plan` records the user's selection via
  // `Sprint.setAffectedRepositories`; the ideate flow reads it directly.
  if (sprint.affectedRepositories.length === 0) return '(no repositories selected)';
  return sprint.affectedRepositories.map((p) => `- ${String(p)}`).join('\n');
}

/**
 * Render the optional existing-AGENTS.md slot. The prompt expects either
 * a fenced block describing the prior body, or an empty string when the
 * onboarding mode is `bootstrap` (no prior file).
 */
function renderExistingAgentsMd(body: string | undefined): string {
  if (body === undefined) return '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  return ['**Existing project context file body:**', '', '```markdown', trimmed, '```'].join('\n');
}

/**
 * Sprint-level affected repos — `sprint plan` records the user's
 * selection on the sprint aggregate. The planner inspects this set
 * when populating `{{PROJECT_TOOLING}}`.
 */
function collectAffectedRepoPaths(sprint: Sprint): readonly AbsolutePath[] {
  return sprint.affectedRepositories;
}

/**
 * Render the plan prompt's `{{CONTEXT}}` block — sprint identity,
 * project, sprint-level repos, tickets with their refined requirements,
 * and the prior task set when this is a replan. Without this Claude has
 * nothing to plan against.
 */
function renderPlanContext(sprint: Sprint, existingTasks: readonly Task[]): string {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprint.name}`);
  lines.push('', `Sprint ID: ${String(sprint.id)}`);
  lines.push('', `Project: ${String(sprint.projectName)}`);

  // Sprint-level affected repos. After sprint-per-project, the user's
  // checkbox selection is recorded on the sprint aggregate (not per
  // ticket), so the planner reads them directly here.
  if (sprint.affectedRepositories.length > 0) {
    lines.push('', '## Repositories');
    for (const r of sprint.affectedRepositories) lines.push(`- ${String(r)}`);
  }

  if (sprint.tickets.length === 0) {
    lines.push('', '_No tickets on this sprint._');
    return lines.join('\n');
  }

  // Tickets — refined requirements are what the planner reads. Anything
  // still pending should already have been blocked upstream, but we
  // render it conservatively so a partial run is still legible.
  lines.push('', '## Tickets');
  for (const t of sprint.tickets) {
    lines.push('', `### [${String(t.id)}] ${t.title}`);
    if (t.description !== undefined && t.description.length > 0) {
      lines.push('', `**Description:** ${t.description}`);
    }
    if (t.link !== undefined) lines.push('', `**Link:** ${t.link}`);
    lines.push('', `**Requirement status:** ${t.requirementStatus}`);
    if (t.requirements !== undefined && t.requirements.trim().length > 0) {
      lines.push('', '**Requirements:**', '', t.requirements.trim());
    }
  }

  // Existing tasks (replan signal). The planner is told its output
  // REPLACES this list — the harness saves the new array atomically.
  if (existingTasks.length > 0) {
    lines.push('', '## Existing Tasks (will be replaced)');
    for (const task of existingTasks) {
      lines.push('', `### ${task.name}`);
      lines.push(`- id: ${String(task.id)}`);
      if (task.description !== undefined) lines.push(`- description: ${task.description}`);
      if (task.ticketId !== undefined) lines.push(`- ticketId: ${String(task.ticketId)}`);
      lines.push(`- projectPath: ${String(task.projectPath)}`);
      lines.push(`- status: ${task.status}`);
    }
  }

  return lines.join('\n');
}
