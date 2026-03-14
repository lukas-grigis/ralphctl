import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from 'typescript-result';
import { formatTicketDisplay } from '@src/store/ticket.ts';
import { spawnInteractive } from '@src/ai/session.ts';
import { getActiveProvider } from '@src/providers/index.ts';
import { extractJsonArray } from '@src/utils/json-extract.ts';
import { type RefinedRequirement, RefinedRequirementsSchema, type Ticket } from '@src/schemas/index.ts';

/**
 * Format a single ticket for the AI prompt.
 */
export function formatTicketForPrompt(ticket: Ticket): string {
  const lines: string[] = [];

  lines.push(`### ${formatTicketDisplay(ticket)}`);
  lines.push(`Project: ${ticket.projectName}`);

  if (ticket.description) {
    lines.push('');
    lines.push('**Description:**');
    lines.push(ticket.description);
  }
  if (ticket.link) {
    lines.push('');
    lines.push(`**Link:** ${ticket.link}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Parse a requirements JSON file into validated RefinedRequirement array.
 */
export function parseRequirementsFile(content: string): RefinedRequirement[] {
  // Try to extract a balanced JSON array from the content (handles surrounding text)
  const jsonStr = extractJsonArray(content);

  const parseR = Result.try(() => JSON.parse(jsonStr) as unknown);
  if (!parseR.ok) {
    throw new Error(`Invalid JSON: ${parseR.error.message}`, { cause: parseR.error });
  }
  const parsed = parseR.value;

  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }

  // Validate against schema
  const result = RefinedRequirementsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `[${issue.path.join('.')}]` : '';
        return `  ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid requirements format:\n${issues}`);
  }

  return result.data;
}

/**
 * Run an interactive AI session for refinement in the given working directory.
 */
export async function runAiSession(workingDir: string, prompt: string, ticketTitle: string): Promise<void> {
  // Write full context to a file for reference
  const contextFile = join(workingDir, 'refine-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  const provider = await getActiveProvider();

  // Build initial prompt that tells the AI to read the context file
  const startPrompt = `I need help refining the requirements for "${ticketTitle}". The full context is in refine-context.md. Please read that file now and follow the instructions to help refine the ticket requirements.`;

  const result = spawnInteractive(
    startPrompt,
    {
      cwd: workingDir,
    },
    provider
  );

  if (result.error) {
    throw new Error(result.error);
  }
}
