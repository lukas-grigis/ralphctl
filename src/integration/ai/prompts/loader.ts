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
 * Neutral, ecosystem-agnostic check-gate example. Pre-expanded inside the
 * planner partials so generated `steps` / `verificationCriteria` examples do
 * not leak Node-specific commands (`pnpm test`, `npm run lint`) to prompts
 * that run in Python / Go / Rust / Java / mixed repos. Downstream projects
 * supply the real command via `{{PROJECT_TOOLING}}` at runtime.
 */
const CHECK_GATE_EXAMPLE =
  "Run the project's check gate — all pass (omit this step when the project has no check script)";

/**
 * Planner builders substitute `{{PROJECT_TOOLING}}` and
 * `{{CHECK_GATE_EXAMPLE}}` inside `plan-common` first so the outer
 * `composePrompt` can plug the result into `{{COMMON}}` as opaque text.
 */
function buildPlanCommon(projectToolingSection: string): string {
  // PLAN_COMMON_EXAMPLES is substituted first so its embedded
  // `{{CHECK_GATE_EXAMPLE}}` placeholder is caught by the subsequent
  // iteration of composePrompt — order matters here.
  return composePrompt(loadPartial('plan-common'), {
    PLAN_COMMON_EXAMPLES: loadPartial('plan-common-examples'),
    PROJECT_TOOLING: projectToolingSection,
    CHECK_GATE_EXAMPLE,
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
  CHECK_GATE_EXAMPLE: string;
} {
  return {
    HARNESS_CONTEXT: loadPartial('harness-context'),
    COMMON: buildPlanCommon(projectToolingSection),
    VALIDATION: loadPartial('validation-checklist'),
    SIGNALS: loadPartial('signals-planning'),
    CHECK_GATE_EXAMPLE,
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
  let template = loadTemplate('task-execution');
  // Prettier reflows markdown and re-indents continuation lines, so the
  // template's indent around {{COMMIT_STEP}} / {{COMMIT_CONSTRAINT}} isn't
  // stable. When noCommit is true, collapse the entire placeholder line
  // (leading whitespace + placeholder + trailing newline) to a single newline
  // so no indented-empty line survives. When false, keep the placeholder as
  // a normal substitution — the inserted content is a peer bullet at column 0
  // (the template surrounds the placeholder with blank lines so the bullet
  // renders as a sibling of the other constraints, not a sub-bullet).
  if (noCommit) {
    template = template.replace(/^[ \t]*\{\{COMMIT_STEP\}\}\n/m, '\n');
    template = template.replace(/^[ \t]*\{\{COMMIT_CONSTRAINT\}\}\n/m, '');
  }
  const commitStep = noCommit
    ? ''
    : '   - **Before continuing:** Create a git commit with a descriptive message for the changes made.';
  const commitConstraint = noCommit ? '' : '- **Must commit** — Create a git commit before signaling completion.';
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
  // Wrap non-empty issue context in <context>…</context> for canonical XML
  // framing. Empty input stays empty — no orphan tag pair in the rendered
  // output when the ticket carries no upstream issue link.
  const issueContextSection = issueContext ? `<context>\n\n${issueContext}\n\n</context>` : '';
  return composePrompt(template, {
    TICKET: ticketContent,
    OUTPUT_FILE: outputFile,
    SCHEMA: schema,
    ISSUE_CONTEXT: issueContextSection,
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
      (name) =>
        `\n<dimension name="${name}" floor="false">\nAdditional task-specific dimension flagged by the planner. Apply judgment to whether the implementation satisfies this dimension given the task's verification criteria and steps.\n</dimension>\n`
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

/**
 * Build the check-script discovery prompt for `project add` / `project repo
 * add`. The agent is read-only — it inspects a small allowlist of config
 * files and emits a single `<check-script>` block that the user reviews
 * before saving. See `parseCheckScriptOutput` for the output contract.
 */
export function buildCheckScriptDiscoverPrompt(repoPath: string): string {
  return composePrompt(loadTemplate('check-script-discover'), {
    REPO_PATH: repoPath,
  });
}

export interface RepoOnboardPromptContext {
  repoPath: string;
  mode: 'bootstrap' | 'adopt' | 'update';
  existingAgentsMd: string | null;
  projectType: string;
  checkScriptSuggestion: string;
  /** Provider-native file name (e.g. `CLAUDE.md`, `.github/copilot-instructions.md`). */
  fileName: string;
}

/**
 * Build the `project onboard` prompt. Fills in the mode and existing-file
 * context so the AI produces a mode-appropriate project context file proposal + a
 * check-script suggestion. See `repo-onboard.md` for the output contract.
 */
export function buildRepoOnboardPrompt(ctx: RepoOnboardPromptContext): string {
  const existingSection = ctx.existingAgentsMd
    ? `\n**Existing project context file:**\n\n\`\`\`\n${ctx.existingAgentsMd}\n\`\`\`\n`
    : '';
  return composePrompt(loadTemplate('repo-onboard'), {
    REPO_PATH: ctx.repoPath,
    MODE: ctx.mode,
    EXISTING_AGENTS_MD: existingSection,
    PROJECT_TYPE: ctx.projectType || 'unknown',
    CHECK_SCRIPT_SUGGESTION: ctx.checkScriptSuggestion,
    FILE_NAME: ctx.fileName,
  });
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
