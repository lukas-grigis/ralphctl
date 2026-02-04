import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { error, info, muted, success, warning } from '@src/theme/index.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { formatTicketDisplay, getPendingTickets, groupTicketsByProject } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { buildSpecRefinePrompt } from '@src/claude/prompts/index.ts';
import { spawnClaudeInteractive } from '@src/claude/session.ts';
import { fileExists } from '@src/utils/storage.ts';
import type { Ticket } from '@src/schemas/index.ts';

interface RefineOptions {
  project?: string;
}

function parseArgs(args: string[]): { sprintId?: string; options: RefineOptions } {
  const options: RefineOptions = {};
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--project') {
      options.project = nextArg;
      i++;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

async function formatTicketsForPrompt(tickets: Ticket[]): Promise<string> {
  const lines: string[] = [];

  for (const ticket of tickets) {
    lines.push(`### ${formatTicketDisplay(ticket)}`);
    lines.push(`Project: ${ticket.projectName}`);

    // Get project repositories
    try {
      const project = await getProject(ticket.projectName);
      const repoPaths = project.repositories.map((r) => `${r.name} (${r.path})`);
      lines.push(`Repositories: ${repoPaths.join(', ')}`);
    } catch {
      lines.push('Repositories: (project not found)');
    }

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
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

interface RefinedSpec {
  ref: string;
  specs: string;
}

function parseSpecsFile(content: string): RefinedSpec[] {
  // Try to extract JSON array from the content
  const jsonMatch = /\[[\s\S]*\]/.exec(content);
  if (!jsonMatch) {
    throw new Error('No JSON array found in specs file');
  }

  const parsed = JSON.parse(jsonMatch[0]) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }

  return parsed as RefinedSpec[];
}

async function runClaudeSession(
  primaryPath: string,
  additionalPaths: string[],
  prompt: string,
  ticketCount: number
): Promise<void> {
  // Write full context to a file for reference
  const contextFile = join(primaryPath, '.ralphctl-refine-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  // Build initial prompt that tells Claude to read the context file
  const startPrompt = `I need help refining specifications for ${String(ticketCount)} ticket(s). The full context is in .ralphctl-refine-context.md. Please read that file now and follow the instructions to help refine the ticket specifications.`;

  // Build args for Claude session
  const args: string[] = [];
  for (const path of additionalPaths) {
    args.push('--add-dir', path);
  }

  const result = await spawnClaudeInteractive(startPrompt, {
    cwd: primaryPath,
    args,
    env: {
      // Load CLAUDE.md from --add-dir paths too
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });

  // Clean up context file after session ends
  try {
    await unlink(contextFile);
  } catch {
    // Ignore cleanup errors
  }

  if (result.error) {
    throw new Error(result.error);
  }
}

export async function sprintRefineCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    console.log(warning('\nNo sprint specified and no current sprint set.'));
    console.log(muted('Specify a sprint ID or create one first.\n'));
    return;
  }

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to refine
  try {
    assertSprintStatus(sprint, ['draft'], 'refine');
  } catch (err) {
    if (err instanceof Error) {
      console.log(error(`\n${err.message}\n`));
    }
    return;
  }

  if (sprint.tickets.length === 0) {
    console.log(warning('\nNo tickets in sprint.'));
    console.log(muted('Add tickets first: ralphctl ticket add --project <project-name>\n'));
    return;
  }

  // Get pending tickets
  const pendingTickets = getPendingTickets(sprint.tickets);

  if (pendingTickets.length === 0) {
    console.log(success('\nAll tickets already have approved specs!'));
    console.log(muted('Run "ralphctl sprint plan" to generate tasks.\n'));
    return;
  }

  console.log(info('\n=== Spec Refinement ==='));
  console.log(info('Sprint:  ') + sprint.name);
  console.log(info('ID:      ') + sprint.id);
  console.log(muted(`Pending: ${String(pendingTickets.length)} ticket(s)`));
  console.log('');

  // Group pending tickets by project
  const ticketsByProject = groupTicketsByProject(pendingTickets);

  // Filter by project if specified
  let projectsToProcess = Array.from(ticketsByProject.keys());
  if (options.project) {
    if (!ticketsByProject.has(options.project)) {
      console.log(warning(`\nNo pending tickets for project: ${options.project}`));
      console.log(muted('Available projects:'));
      for (const proj of ticketsByProject.keys()) {
        console.log(muted(`  - ${proj}`));
      }
      console.log('');
      return;
    }
    projectsToProcess = [options.project];
  }

  console.log(info('Projects to refine:'));
  for (const proj of projectsToProcess) {
    const count = ticketsByProject.get(proj)?.length ?? 0;
    console.log(`  - ${proj} (${String(count)} ticket(s))`);
  }
  console.log('');

  // Process each project
  for (const projectName of projectsToProcess) {
    const projectTickets = ticketsByProject.get(projectName) ?? [];

    console.log(info(`\n--- Project: ${projectName} ---`));
    console.log(muted(`Tickets: ${String(projectTickets.length)}`));

    for (const ticket of projectTickets) {
      console.log(`  - ${formatTicketDisplay(ticket)}`);
    }
    console.log('');

    // Get project repositories for Claude session
    let projectRepos: { name: string; path: string }[];
    try {
      const project = await getProject(projectName);
      projectRepos = project.repositories;
    } catch {
      console.log(warning(`Project '${projectName}' not found.`));
      console.log(muted('Skipping refinement for this project.\n'));
      continue;
    }

    if (projectRepos.length === 0) {
      console.log(warning(`Project '${projectName}' has no repositories configured.`));
      console.log(muted('Skipping refinement for this project.\n'));
      continue;
    }

    // Select which paths Claude should explore
    let selectedPaths: string[];
    const firstRepo = projectRepos[0];
    if (projectRepos.length === 1 && firstRepo) {
      selectedPaths = [firstRepo.path];
    } else {
      console.log(info('\nWhich repositories should Claude explore for these tickets?'));
      selectedPaths = await checkbox({
        message: 'Select repositories',
        choices: projectRepos.map((r) => ({ name: `${r.name} (${r.path})`, value: r.path, checked: true })),
        required: true,
      });

      if (selectedPaths.length === 0) {
        console.log(muted('No paths selected. Skipping.\n'));
        continue;
      }
    }

    const proceed = await confirm({
      message: `Start refinement session for ${projectName}?`,
      default: true,
    });

    if (!proceed) {
      console.log(muted('Skipped.\n'));
      continue;
    }

    // Create output file for specs
    const outputFile = join(tmpdir(), `ralphctl-specs-${id}-${String(Date.now())}.json`);

    // Build prompt and run Claude session
    const ticketsContent = await formatTicketsForPrompt(projectTickets);
    const prompt = buildSpecRefinePrompt(ticketsContent, outputFile);

    // Debug: show prompt size to verify content is being generated
    const promptLines = prompt.split('\n').length;
    const promptChars = prompt.length;
    console.log(muted(`\nPrompt: ${String(promptLines)} lines, ${String(promptChars)} chars`));

    const primaryPath = selectedPaths[0] ?? process.cwd();
    const additionalPaths = selectedPaths.slice(1);

    console.log(muted('Starting interactive Claude session...'));
    console.log(muted(`Primary path: ${primaryPath}`));
    if (additionalPaths.length > 0) {
      console.log(muted(`Additional paths: ${additionalPaths.join(', ')}`));
    }
    console.log(muted(`When ready, Claude will write specs to: ${outputFile}\n`));

    try {
      await runClaudeSession(primaryPath, additionalPaths, prompt, projectTickets.length);
    } catch (err) {
      if (err instanceof Error) {
        console.log(error(`\nFailed to run Claude session: ${err.message}`));
      }
      continue;
    }

    console.log('');

    // Check if specs file was created
    if (await fileExists(outputFile)) {
      console.log(info('Specs file found. Processing...'));

      let content: string;
      try {
        content = await readFile(outputFile, 'utf-8');
      } catch {
        console.log(error(`\nFailed to read specs file: ${outputFile}\n`));
        continue;
      }

      let refinedSpecs: RefinedSpec[];
      try {
        refinedSpecs = parseSpecsFile(content);
      } catch (err) {
        if (err instanceof Error) {
          console.log(error(`\nFailed to parse specs file: ${err.message}\n`));
        }
        continue;
      }

      if (refinedSpecs.length === 0) {
        console.log(warning('\nNo specs in file.\n'));
        continue;
      }

      console.log(success(`\nParsed ${String(refinedSpecs.length)} spec(s).\n`));

      // Match specs to tickets first
      const matchedSpecs: { spec: RefinedSpec; ticket: Ticket; ticketIdx: number }[] = [];
      for (const spec of refinedSpecs) {
        const ticketIdx = sprint.tickets.findIndex(
          (t) => t.id === spec.ref || t.externalId === spec.ref || t.title === spec.ref
        );
        if (ticketIdx !== -1) {
          const ticket = sprint.tickets[ticketIdx];
          if (ticket) {
            matchedSpecs.push({ spec, ticket, ticketIdx });
          }
        } else {
          console.log(warning(`  ? No matching ticket for ref: ${spec.ref}`));
        }
      }

      if (matchedSpecs.length === 0) {
        console.log(warning('No specs matched any tickets.\n'));
        continue;
      }

      // Ask how to review specs
      const reviewMode = await select({
        message: `How to review ${String(matchedSpecs.length)} spec(s)?`,
        choices: [
          { name: 'Review one by one', value: 'individual' },
          { name: 'Approve all (skip review)', value: 'skip' },
          { name: 'Cancel (discard all)', value: 'cancel' },
        ],
      });

      if (reviewMode === 'cancel') {
        console.log(muted('Specs discarded.\n'));
        continue;
      }

      const approvedSpecs: { spec: RefinedSpec; ticket: Ticket; ticketIdx: number }[] = [];

      if (reviewMode === 'skip') {
        approvedSpecs.push(...matchedSpecs);
      } else {
        // Review one by one
        for (const matched of matchedSpecs) {
          console.log(info(`\n=== ${formatTicketDisplay(matched.ticket)} ===`));
          console.log(muted('─'.repeat(60)));
          console.log(matched.spec.specs);
          console.log(muted('─'.repeat(60)));

          const approved = await confirm({
            message: 'Approve this spec?',
            default: true,
          });

          if (approved) {
            approvedSpecs.push(matched);
            console.log(success('  Approved'));
          } else {
            console.log(muted('  Skipped'));
          }
        }
      }

      // Save approved specs
      if (approvedSpecs.length > 0) {
        for (const { spec, ticketIdx } of approvedSpecs) {
          const ticket = sprint.tickets[ticketIdx];
          if (ticket) {
            ticket.specs = spec.specs;
            ticket.specStatus = 'approved';
          }
        }
        await saveSprint(sprint);
        console.log(success(`\nStored specs for ${String(approvedSpecs.length)} ticket(s).`));
      } else {
        console.log(muted('\nNo specs approved.'));
      }

      // Clean up temp file
      try {
        await unlink(outputFile);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      console.log(warning('No specs file found.'));
      console.log(muted(`Expected: ${outputFile}`));

      // Ask if user wants to manually mark as approved
      const manualApprove = await confirm({
        message: 'Mark tickets as approved anyway (specs entered manually)?',
        default: false,
      });

      if (manualApprove) {
        for (const ticket of projectTickets) {
          const idx = sprint.tickets.findIndex((t) => t.id === ticket.id);
          if (idx !== -1) {
            const t = sprint.tickets[idx];
            if (t) {
              t.specStatus = 'approved';
            }
          }
        }
        await saveSprint(sprint);
        console.log(success(`Marked ${String(projectTickets.length)} ticket(s) as approved.`));
      } else {
        console.log(muted('Tickets not marked as approved. Run refinement again later.'));
      }
    }
  }

  // Summary
  const remainingPending = getPendingTickets(sprint.tickets);
  console.log(info('\n=== Summary ==='));
  console.log(info('Approved: ') + String(pendingTickets.length - remainingPending.length) + ' ticket(s)');
  console.log(info('Pending:  ') + String(remainingPending.length) + ' ticket(s)');

  if (remainingPending.length === 0) {
    console.log(success('\nAll specs approved!'));
    console.log(muted('Run "ralphctl sprint plan" to generate tasks.\n'));
  } else {
    console.log(muted('\nContinue refinement with: ralphctl sprint refine\n'));
  }
}
