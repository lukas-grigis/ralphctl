import type { BuildOnboardPromptInput, PromptBuilderPort } from '../../../business/ports/prompt-builder-port.ts';
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { Ticket } from '../../../domain/entities/ticket.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { detectProjectTooling } from '../../external/project-tooling.ts';
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
  ideate: 'ideate',
  execute: 'task-execution',
  evaluate: 'task-evaluation',
  feedback: 'sprint-feedback',
  onboard: 'repo-onboard',
} as const;

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

  async buildRefinePrompt(input: { ticket: Ticket }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.refine);
    if (!tpl.ok) return Result.error(tpl.error);
    return Result.ok(
      substitute(tpl.value, {
        TICKET: renderTicket(input.ticket),
        ISSUE_CONTEXT: renderIssueContext(input.ticket),
        // Caller-controlled IO target / schema — left empty so downstream
        // composition can layer them. Empty (rather than absent) ensures
        // the placeholders are removed from the rendered prompt.
        OUTPUT_FILE: '',
        SCHEMA: '',
      })
    );
  }

  async buildPlanPrompt(input: {
    sprint: Sprint;
    existingTasks: readonly Task[];
  }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.plan);
    if (!tpl.ok) return Result.error(tpl.error);

    // Project tooling is detected union-wise across every repo touched by
    // the sprint's tickets — `sprint plan` saves these per-ticket and the
    // planner needs the full picture before generating tasks.
    const repoPaths = collectAffectedRepoPaths(input.sprint);
    const tooling = await detectProjectTooling(repoPaths);

    return Result.ok(
      substitute(tpl.value, {
        // `plan-common.md` is a partial — its placeholders are filled by
        // the outer composition step in the legacy loader.
        PLAN_COMMON_EXAMPLES: '',
        PROJECT_TOOLING: tooling.rendered,
      })
    );
  }

  async buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>> {
    const tpl = await this.loader.load(TEMPLATE_NAMES.ideate);
    if (!tpl.ok) return Result.error(tpl.error);
    const projectName = input.sprint.tickets[0]?.projectName ?? '';
    const repositories = renderRepositories(input.sprint);
    return Result.ok(
      substitute(tpl.value, {
        IDEA_TITLE: input.sprint.name,
        IDEA_DESCRIPTION: input.ideaText,
        PROJECT_NAME: projectName,
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
  const lines: string[] = [`**Title:** ${ticket.title}`, `**ID:** ${ticket.id}`, `**Project:** ${ticket.projectName}`];
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

function renderRepositories(sprint: Sprint): string {
  // Union of every ticket's affectedRepositories — `sprint plan` saves
  // these per-ticket, and the ideate flow consumes them union-wise.
  const seen = new Set<string>();
  for (const t of sprint.tickets) {
    if (t.affectedRepositories === undefined) continue;
    for (const r of t.affectedRepositories) seen.add(r);
  }
  if (seen.size === 0) return '(no repositories selected)';
  return [...seen].map((p) => `- ${p}`).join('\n');
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
 * Union of every ticket's `affectedRepositories` paths in this sprint —
 * the planner inspects the full set when populating `{{PROJECT_TOOLING}}`.
 */
function collectAffectedRepoPaths(sprint: Sprint): readonly AbsolutePath[] {
  const seen = new Set<AbsolutePath>();
  for (const t of sprint.tickets) {
    if (t.affectedRepositories === undefined) continue;
    for (const r of t.affectedRepositories) seen.add(r);
  }
  return [...seen];
}
