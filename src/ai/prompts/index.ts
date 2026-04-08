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
 * Loads a partial template and normalizes trailing whitespace so consumers
 * can safely concatenate or substitute without leaving double blank lines.
 */
function loadPartial(name: string): string {
  return loadTemplate(name).replace(/\s+$/, '');
}

/**
 * Substitutes every {{KEY}} placeholder in `template` with values from
 * `substitutions`. Throws if any {{...}} token remains after substitution —
 * this guarantees every placeholder is explicitly handled by the caller.
 */
function composePrompt(template: string, substitutions: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(substitutions)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  const remaining = result.match(/\{\{[A-Z_]+\}\}/g);
  if (remaining) {
    throw new Error(`composePrompt: unreplaced placeholders: ${[...new Set(remaining)].join(', ')}`);
  }
  return result;
}

/**
 * Compose the `plan-common` partial with the project tooling section
 * pre-substituted. Planner builders do this as a first pass so the outer
 * `composePrompt` call can plug the result into `{{COMMON}}` as opaque text.
 */
function buildPlanCommon(projectToolingSection: string): string {
  return composePrompt(loadPartial('plan-common'), {
    PROJECT_TOOLING: projectToolingSection,
  });
}

export function buildInteractivePrompt(
  context: string,
  outputFile: string,
  schema: string,
  projectToolingSection: string
): string {
  const template = loadTemplate('plan-interactive');
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
    CONTEXT: context,
    OUTPUT_FILE: outputFile,
    SCHEMA: schema,
  });
}

export function buildAutoPrompt(context: string, schema: string, projectToolingSection: string): string {
  const template = loadTemplate('plan-auto');
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
    CONTEXT: context,
    SCHEMA: schema,
  });
}

export function buildTaskExecutionPrompt(progressFilePath: string, noCommit: boolean, contextFileName: string): string {
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
  const template = loadTemplate('ideate');
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
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
  const template = loadTemplate('ideate-auto');
  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
    IDEA_TITLE: ideaTitle,
    IDEA_DESCRIPTION: ideaDescription,
    PROJECT_NAME: projectName,
    REPOSITORIES: repositories,
    SCHEMA: schema,
  });
}

export interface EvaluatorPromptContext {
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

  return composePrompt(template, {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    SIGNALS: loadPartial('signals-evaluation'),
    TASK_NAME: ctx.taskName,
    TASK_DESCRIPTION_SECTION: descriptionSection,
    TASK_STEPS_SECTION: stepsSection,
    VERIFICATION_CRITERIA_SECTION: criteriaSection,
    PROJECT_PATH: ctx.projectPath,
    CHECK_SCRIPT_SECTION: checkSection,
    PROJECT_TOOLING_SECTION: ctx.projectToolingSection,
  });
}

export interface EvaluationResumePromptContext {
  /** Full evaluator critique to feed back to the generator. */
  critique: string;
  /** When true, the generator must commit before signaling completion. */
  needsCommit: boolean;
}

/**
 * Build the prompt that resumes the generator after a failed evaluation.
 * Lives in `task-evaluation-resume.md` so it can be reviewed alongside the
 * other prompt templates instead of being a string literal in executor.ts.
 */
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
