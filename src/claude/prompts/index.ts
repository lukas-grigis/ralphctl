import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(name: string): string {
  return readFileSync(join(__dirname, `${name}.md`), 'utf-8');
}

export function buildInteractivePrompt(context: string, outputFile: string, schema: string): string {
  const template = loadTemplate('plan-interactive');
  return template.replace('{{CONTEXT}}', context).replace('{{OUTPUT_FILE}}', outputFile).replace('{{SCHEMA}}', schema);
}

export function buildAutoPrompt(context: string, schema: string): string {
  const template = loadTemplate('plan-auto');
  return template.replace('{{CONTEXT}}', context).replace('{{SCHEMA}}', schema);
}

export function buildTaskExecutionPrompt(progressFilePath: string, noCommit: boolean, contextFileName: string): string {
  const template = loadTemplate('task-execution');
  const commitInstruction = noCommit ? '' : '5. Make a git commit with a descriptive message.\n';
  return template
    .replace('{{PROGRESS_FILE}}', progressFilePath)
    .replace('{{COMMIT_INSTRUCTION}}', commitInstruction)
    .replaceAll('{{CONTEXT_FILE}}', contextFileName);
}

export function buildTicketRefinePrompt(ticketContent: string, outputFile: string): string {
  const template = loadTemplate('ticket-refine');
  return template.replace('{{TICKET}}', ticketContent).replace('{{OUTPUT_FILE}}', outputFile);
}
