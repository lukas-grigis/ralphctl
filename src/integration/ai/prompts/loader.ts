import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dev: __dirname is src/ai/prompts/, templates are right here.
// In dist bundle: __dirname is dist/, templates are at dist/prompts/.
function getPromptDir(): string {
  const bundled = join(__dirname, 'prompts');
  if (existsSync(bundled)) return bundled;
  return __dirname;
}

const promptDir = getPromptDir();

function loadTemplate(name: string): string {
  return readFileSync(join(promptDir, `${name}.md`), 'utf-8');
}

/**
 * Loads a raw prompt partial from disk, trimming trailing whitespace so consumers
 * can concatenate partials without leaving double blank lines at the seams.
 *
 * @internal Exported only so prompt-audit tests (index.test.ts) can enumerate raw
 * template files. Not intended for production callers — use the `build*Prompt`
 * functions instead, which compose partials through `composePrompt`.
 */
export function loadPartial(name: string): string {
  return loadTemplate(name).replace(/\s+$/, '');
}

const UNREPLACED_TOKEN_RE = /\{\{[A-Z_]+\}\}/g;

/**
 * The strict throw is the contract: any missing substitution is a bug in the
 * caller's map, not a runtime degradation we want to tolerate silently.
 */
function composePrompt(template: string, substitutions: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(substitutions)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  const remaining = result.match(UNREPLACED_TOKEN_RE);
  if (remaining) {
    throw new Error(`composePrompt: unreplaced placeholders: ${[...new Set(remaining)].join(', ')}`);
  }
  return result;
}

/**
 * Planner builders substitute `{{PROJECT_TOOLING}}` inside `plan-common`
 * first so the outer `composePrompt` can plug the result into `{{COMMON}}`
 * as opaque text.
 */
function buildPlanCommon(projectToolingSection: string): string {
  return composePrompt(loadPartial('plan-common'), {
    PROJECT_TOOLING: projectToolingSection,
  });
}

/**
 * Substitutions shared by all planner-role builders (plan-auto,
 * plan-interactive, ideate, ideate-auto). Keeping them in one place means
 * adding a new planner partial is a one-line change.
 */
function buildPlannerBase(projectToolingSection: string): {
  HARNESS_CONTEXT: string;
  COMMON: string;
  VALIDATION: string;
  SIGNALS: string;
} {
  return {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
  };
}

export function buildInteractivePrompt(
  context: string,
  outputFile: string,
  schema: string,
  projectToolingSection: string
): string {
  return composePrompt(loadTemplate('plan-interactive'), {
    ...buildPlannerBase(projectToolingSection),
    CONTEXT: context,
    OUTPUT_FILE: outputFile,
    SCHEMA: schema,
  });
}

export function buildAutoPrompt(context: string, schema: string, projectToolingSection: string): string {
  return composePrompt(loadTemplate('plan-auto'), {
    ...buildPlannerBase(projectToolingSection),
    CONTEXT: context,
    SCHEMA: schema,
  });
}

export function buildTaskExecutionPrompt(
  progressFilePath: string,
  noCommit: boolean,
  contextFileName: string,
  projectToolingSection = ''
): string {
  const template = loadTemplate('task-execution');
  // COMMIT_STEP renders as a sub-bullet under Phase 3 step 2 (verification). Keeping it
  // as a nested list item avoids the list-gap anti-pattern: when noCommit is true, the
  // substitution is the empty string and the surrounding numbered list stays intact.
  const commitStep = noCommit
    ? ''
    : '\n   - **Before continuing:** Create a git commit with a descriptive message for the changes made.';
  const commitConstraint = noCommit ? '' : '- **Must commit** — Create a git commit before signaling completion.\n';
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    SIGNALS: loadPartial('signals-task'),
    PROGRESS_FILE: progressFilePath,
    COMMIT_STEP: commitStep,
    COMMIT_CONSTRAINT: commitConstraint,
    CONTEXT_FILE: contextFileName,
    PROJECT_TOOLING: projectToolingSection,
  });
}

export function buildTicketRefinePrompt(
  ticketContent: string,
  outputFile: string,
  schema: string,
  issueContext = ''
): string {
  const template = loadTemplate('ticket-refine');
  return composePrompt(template, {
    TICKET: ticketContent,
    OUTPUT_FILE: outputFile,
    SCHEMA: schema,
    ISSUE_CONTEXT: issueContext,
  });
}

export function buildIdeatePrompt(
  ideaTitle: string,
  ideaDescription: string,
  projectName: string,
  repositories: string,
  outputFile: string,
  schema: string,
  projectToolingSection: string
): string {
  return composePrompt(loadTemplate('ideate'), {
    ...buildPlannerBase(projectToolingSection),
    IDEA_TITLE: ideaTitle,
    IDEA_DESCRIPTION: ideaDescription,
    PROJECT_NAME: projectName,
    REPOSITORIES: repositories,
    OUTPUT_FILE: outputFile,
    SCHEMA: schema,
  });
}

export function buildIdeateAutoPrompt(
  ideaTitle: string,
  ideaDescription: string,
  projectName: string,
  repositories: string,
  schema: string,
  projectToolingSection: string
): string {
  return composePrompt(loadTemplate('ideate-auto'), {
    ...buildPlannerBase(projectToolingSection),
    IDEA_TITLE: ideaTitle,
    IDEA_DESCRIPTION: ideaDescription,
    PROJECT_NAME: projectName,
    REPOSITORIES: repositories,
    SCHEMA: schema,
  });
}

interface EvaluatorPromptContext {
  taskName: string;
  taskDescription: string;
  taskSteps: string[];
  verificationCriteria: string[];
  projectPath: string;
  checkScriptSection: string | null;
  /**
   * Pre-rendered "Project Tooling" section listing available subagents,
   * skills, MCP servers, and instruction files. Empty string when nothing
   * was detected — the template handles empty placeholders cleanly.
   */
  projectToolingSection: string;
  /**
   * Optional planner-emitted dimensions stacked on top of the four floor
   * dimensions (Correctness/Completeness/Safety/Consistency). Empty array
   * means "floor only" — no extra blocks are rendered.
   */
  extraDimensions: string[];
}

/**
 * Render the three EXTRA_DIMENSIONS slots from the planner-emitted dimension
 * names. All three slots are the empty string when no extras are present —
 * keeping the surrounding markdown structure intact (no orphan headings,
 * no double blank lines).
 *
 * - `section`: full dimension definitions appended after Dimension 4.
 * - `passBar`: extra bullets appended to the Pass Bar list.
 * - `assessment`: extra `**Name**: …` lines appended to the Assessment block
 *   in the output template.
 */
function renderExtraDimensions(extras: string[]): {
  section: string;
  passBar: string;
  assessment: string;
} {
  if (extras.length === 0) {
    return { section: '', passBar: '', assessment: '' };
  }

  const section = extras
    .map(
      (name, i) =>
        `\n**Dimension ${String(5 + i)} — ${name}**\nAdditional task-specific dimension flagged by the planner. Apply judgment to whether the implementation satisfies this dimension given the task's verification criteria and steps.\n`
    )
    .join('');

  const passBar = extras.map((name) => `\n- **${name}**: Task-specific dimension flagged by the planner`).join('');

  return {
    section,
    passBar,
    assessment: extras.map((name) => `\n**${name}**: PASS/FAIL — [one-line finding]`).join(''),
  };
}

export function buildEvaluatorPrompt(ctx: EvaluatorPromptContext): string {
  const template = loadTemplate('task-evaluation');

  const descriptionSection = ctx.taskDescription ? `\n**Description:** ${ctx.taskDescription}` : '';

  const stepsSection =
    ctx.taskSteps.length > 0 ? `\n**Implementation Steps:**\n${ctx.taskSteps.map((s) => `- ${s}`).join('\n')}` : '';

  const criteriaSection =
    ctx.verificationCriteria.length > 0
      ? `\n**Verification Criteria:**\n${ctx.verificationCriteria.map((c) => `- ${c}`).join('\n')}`
      : '';

  const checkSection = ctx.checkScriptSection ? `\n\n${ctx.checkScriptSection}` : '';

  const extras = renderExtraDimensions(ctx.extraDimensions);
  // Both Assessment blocks (pass-only and mixed) get the same per-extra lines —
  // the template only differentiates PASS vs PASS/FAIL on the floor four lines.
  const extraAssessmentPass = extras.assessment.replace(/PASS\/FAIL/g, 'PASS');

  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    SIGNALS: loadPartial('signals-evaluation'),
    TASK_NAME: ctx.taskName,
    TASK_DESCRIPTION_SECTION: descriptionSection,
    TASK_STEPS_SECTION: stepsSection,
    VERIFICATION_CRITERIA_SECTION: criteriaSection,
    PROJECT_PATH: ctx.projectPath,
    CHECK_SCRIPT_SECTION: checkSection,
    PROJECT_TOOLING: ctx.projectToolingSection,
    EXTRA_DIMENSIONS_SECTION: extras.section,
    EXTRA_DIMENSIONS_PASS_BAR: extras.passBar,
    EXTRA_DIMENSIONS_ASSESSMENT_PASS: extraAssessmentPass,
    EXTRA_DIMENSIONS_ASSESSMENT_MIXED: extras.assessment,
  });
}

export function buildSprintFeedbackPrompt(
  sprintName: string,
  completedTasks: string,
  feedback: string,
  branch: string | null
): string {
  const template = loadTemplate('sprint-feedback');
  const branchSection = branch ? `\n**Branch:** ${branch}\n` : '';
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    SIGNALS: loadPartial('signals-task'),
    SPRINT_NAME: sprintName,
    BRANCH_SECTION: branchSection,
    COMPLETED_TASKS: completedTasks,
    FEEDBACK: feedback,
  });
}

interface EvaluationResumePromptContext {
  /** Full evaluator critique to feed back to the generator. */
  critique: string;
  /** When true, the generator must commit before signaling completion. */
  needsCommit: boolean;
}

export function buildEvaluationResumePrompt(ctx: EvaluationResumePromptContext): string {
  const template = loadTemplate('task-evaluation-resume');
  const commitInstruction = ctx.needsCommit
    ? '\n   - **Then commit the fix** with a descriptive message before signaling completion.'
    : '';
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    SIGNALS: loadPartial('signals-task'),
    CRITIQUE: ctx.critique,
    COMMIT_INSTRUCTION: commitInstruction,
  });
}
