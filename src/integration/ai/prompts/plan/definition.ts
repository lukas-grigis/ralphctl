import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { type BuildPromptError, buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { TASK_IMPORT_JSON_SCHEMA } from '@src/integration/ai/prompts/_engine/task-import-schema.ts';

/**
 * Pre-rendered string parameters for the plan template. Plan is **always interactive**:
 * the AI runs in the user's terminal, asks clarifying questions, then writes a JSON task
 * array to {@link PlanPromptParams.outputFilePath}. The harness reads that file back.
 */
export interface PlanPromptParams {
  /** Sprint metadata (id, name, project) for the prompt's introduction. */
  readonly sprintContext: string;
  /** Markdown bulleted list of approved tickets (id + title + requirements) for the planner to map onto tasks. */
  readonly approvedTickets: string;
  /** Markdown bulleted list of repository absolute paths the planner can target. */
  readonly repositories: string;
  /** Optional: existing tasks block, when replanning. */
  readonly existingTasks?: string;
  /** JSON Schema string substituted as `{{SCHEMA}}` for the planner to anchor on. */
  readonly schema: string;
  /**
   * Audit-[09] output contract section — rendered from the plan `AiOutputContract` by
   * `renderContractSectionFor(planOutputContract)`. Tells the AI to write `signals.json`
   * directly with one `task-plan` signal whose `tasksJson` carries the planner output.
   */
  readonly outputContractSection: string;
  /**
   * Current body of `progress.md` substituted into the `## Prior progress on this sprint`
   * section (audit-[07]). Empty when the journal has no entries yet.
   */
  readonly priorProgress: string;
}

const nonEmpty =
  (field: string) =>
  (v: string): Result<string, ValidationError> =>
    v.trim().length === 0
      ? Result.error(new ValidationError({ field, value: v, message: `${field} must not be empty` }))
      : Result.ok(v);

export const planPromptDef: PromptDefinition<PlanPromptParams> = {
  templateName: 'plan',
  description:
    'Interactive task planner. AI explores the repos, asks the user clarifying questions, and writes a JSON task array to OUTPUT_FILE.',
  parameters: {
    sprintContext: {
      placeholder: 'SPRINT_CONTEXT',
      description: 'Sprint id, name, project name.',
      validate: nonEmpty('sprintContext'),
    },
    approvedTickets: {
      placeholder: 'APPROVED_TICKETS',
      description: 'Approved-ticket index — id, title, and full requirements body.',
      validate: nonEmpty('approvedTickets'),
    },
    repositories: {
      placeholder: 'REPOSITORIES',
      description: 'Repository absolute paths the AI can target.',
      validate: nonEmpty('repositories'),
    },
    existingTasks: {
      placeholder: 'EXISTING_TASKS',
      description: 'Replan-mode block listing existing tasks; empty when planning fresh.',
      optional: true,
    },
    schema: {
      placeholder: 'SCHEMA',
      description: 'JSON Schema string the task array conforms to.',
      validate: nonEmpty('schema'),
    },
    outputContractSection: {
      placeholder: 'OUTPUT_CONTRACT_SECTION',
      description:
        'Audit-[09] output contract block rendered from the plan contract — instructs the AI to write `signals.json` directly with one `task-plan` signal.',
      validate: nonEmpty('outputContractSection'),
    },
    priorProgress: {
      placeholder: 'PRIOR_PROGRESS',
      description: 'Current `progress.md` body — empty when the sprint journal has no entries yet.',
    },
  },
  partials: {
    HARNESS_CONTEXT: 'harness-context',
    VALIDATION_CHECKLIST: 'validation-checklist',
  },
  expectedSignals: ['task-plan'],
};

export const renderSprintContext = (sprint: Sprint): string => {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprint.name}`);
  lines.push('', `Sprint ID: ${String(sprint.id)}`);
  lines.push('', `Project ID: ${String(sprint.projectId)}`);
  return lines.join('\n');
};

export const renderApprovedTickets = (sprint: Sprint): string => {
  const approved = sprint.tickets.filter((t) => t.status === 'approved');
  if (approved.length === 0) return '_No approved tickets on this sprint._';
  const lines: string[] = [];
  for (const t of approved) {
    lines.push(`### Ticket \`${String(t.id)}\` — ${t.title}`);
    if (t.externalRef !== undefined && t.externalRef.trim().length > 0) {
      // Informational only — the planner must still use the UUID above as `ticketRef` in the
      // emitted JSON. The clarifying line in the prompt template (see "Ticket reference
      // policy") enforces that contract.
      lines.push('');
      lines.push(`**External reference:** ${t.externalRef.trim()}`);
    }
    lines.push('');
    lines.push(t.requirements.trim().length > 0 ? t.requirements : '_(no requirements body)_');
    lines.push('');
  }
  return lines.join('\n').trim();
};

export const renderRepositories = (project: Project): string => {
  if (project.repositories.length === 0) return '_no repositories configured_';
  return project.repositories.map((r) => `- \`${String(r.path)}\` (${r.name})`).join('\n');
};

export const renderExistingTasks = (tasks: readonly Task[]): string => {
  if (tasks.length === 0) return '';
  const lines: string[] = ['## Existing Tasks (will be replaced)'];
  for (const task of tasks) {
    lines.push('', `### ${task.name}`);
    lines.push(`- ticketRef: ${String(task.ticketId)}`);
    if (task.description !== undefined) lines.push(`- description: ${task.description}`);
    lines.push(`- repositoryId: ${String(task.repositoryId)}`);
    lines.push(`- status: ${task.status}`);
  }
  return lines.join('\n');
};

export interface BuildPlanPromptInput {
  readonly sprint: Sprint;
  readonly project: Project;
  readonly existingTasks?: readonly Task[];
  readonly outputContractSection: string;
  /** Current `progress.md` body — inlined into the prompt's "## Prior progress" section. */
  readonly priorProgress: string;
}

export const buildPlanPrompt = async (
  deps: TemplateLoader,
  input: BuildPlanPromptInput
): Promise<Result<Prompt, BuildPromptError>> => {
  const existing = renderExistingTasks(input.existingTasks ?? []);
  return buildPrompt(deps, planPromptDef, {
    sprintContext: renderSprintContext(input.sprint),
    approvedTickets: renderApprovedTickets(input.sprint),
    repositories: renderRepositories(input.project),
    schema: TASK_IMPORT_JSON_SCHEMA,
    outputContractSection: input.outputContractSection,
    priorProgress: input.priorProgress,
    ...(existing.length > 0 ? { existingTasks: existing } : {}),
  });
};
