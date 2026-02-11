import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(name: string): string {
  return readFileSync(join(__dirname, `${name}.md`), 'utf-8');
}

function buildPlanPrompt(template: string, context: string, schema: string): string {
  const common = loadTemplate('plan-common');
  return template.replace('{{COMMON}}', common).replace('{{CONTEXT}}', context).replace('{{SCHEMA}}', schema);
}

export function buildInteractivePrompt(context: string, outputFile: string, schema: string): string {
  const template = loadTemplate('plan-interactive');
  return buildPlanPrompt(template, context, schema).replace('{{OUTPUT_FILE}}', outputFile);
}

export function buildAutoPrompt(context: string, schema: string): string {
  const template = loadTemplate('plan-auto');
  return buildPlanPrompt(template, context, schema);
}

export function buildTaskExecutionPrompt(progressFilePath: string, noCommit: boolean, contextFileName: string): string {
  const template = loadTemplate('task-execution');
  const commitStep = noCommit
    ? ''
    : '\n> **Before continuing:** Create a git commit with a descriptive message for the changes made.\n';
  const commitConstraint = noCommit ? '' : '- **Must commit** — Create a git commit before signaling completion.\n';
  return template
    .replace('{{PROGRESS_FILE}}', progressFilePath)
    .replace('{{COMMIT_STEP}}', commitStep)
    .replace('{{COMMIT_CONSTRAINT}}', commitConstraint)
    .replaceAll('{{CONTEXT_FILE}}', contextFileName);
}

export function buildTicketRefinePrompt(ticketContent: string, outputFile: string, schema: string): string {
  const template = loadTemplate('ticket-refine');
  return template
    .replace('{{TICKET}}', ticketContent)
    .replace('{{OUTPUT_FILE}}', outputFile)
    .replace('{{SCHEMA}}', schema);
}

export function buildIdeatePrompt(
  ideaTitle: string,
  ideaDescription: string,
  projectName: string,
  repositories: string,
  outputFile: string,
  schema: string
): string {
  const template = loadTemplate('ideate');
  const common = loadTemplate('plan-common');
  return template
    .replace('{{IDEA_TITLE}}', ideaTitle)
    .replace('{{IDEA_DESCRIPTION}}', ideaDescription)
    .replace('{{PROJECT_NAME}}', projectName)
    .replace('{{REPOSITORIES}}', repositories)
    .replace('{{OUTPUT_FILE}}', outputFile)
    .replace('{{SCHEMA}}', schema)
    .replace('{{COMMON}}', common);
}

export function buildIdeateAutoPrompt(
  ideaTitle: string,
  ideaDescription: string,
  projectName: string,
  repositories: string,
  schema: string
): string {
  const template = loadTemplate('ideate-auto');
  const common = loadTemplate('plan-common');
  return template
    .replace('{{IDEA_TITLE}}', ideaTitle)
    .replace('{{IDEA_DESCRIPTION}}', ideaDescription)
    .replace('{{PROJECT_NAME}}', projectName)
    .replace('{{REPOSITORIES}}', repositories)
    .replace('{{SCHEMA}}', schema)
    .replace('{{COMMON}}', common);
}
