import { input, select } from '@inquirer/prompts';
import { error, muted } from '@src/theme/index.ts';
import { field, fieldMultiline, icons, showEmpty, showError, showNextStep, showSuccess } from '@src/theme/ui.ts';
import { multilineInput } from '@src/utils/multiline.ts';
import { addTicket, DuplicateTicketError } from '@src/store/ticket.ts';
import { listProjects, projectExists } from '@src/store/project.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';

export interface TicketAddOptions {
  externalId?: string;
  title?: string;
  description?: string;
  link?: string;
  project?: string;
  useEditor?: boolean;
  interactive?: boolean; // Set by REPL or CLI (default true unless --no-interactive)
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export async function ticketAddCommand(options: TicketAddOptions = {}): Promise<void> {
  const { useEditor = false } = options;

  let externalId: string | undefined;
  let title: string;
  let description: string | undefined;
  let link: string | undefined;
  let projectName: string;

  if (options.interactive === false) {
    // Non-interactive mode: validate required params
    const errors: string[] = [];
    const trimmedTitle = options.title?.trim();
    const trimmedProject = options.project?.trim();

    if (!trimmedTitle) {
      errors.push('--title is required');
    }
    if (!trimmedProject) {
      errors.push('--project is required');
    } else if (!(await projectExists(trimmedProject))) {
      errors.push(`Project '${trimmedProject}' does not exist. Add it first with 'ralphctl project add'.`);
    }
    if (options.link && !validateUrl(options.link)) {
      errors.push('--link must be a valid URL');
    }

    if (errors.length > 0 || !trimmedTitle || !trimmedProject) {
      showError('Validation failed');
      for (const e of errors) {
        console.log(error(`  ${e}`));
      }
      console.log('');
      exitWithCode(EXIT_ERROR);
    }

    const trimmedExternalId = options.externalId?.trim();
    externalId = trimmedExternalId === '' ? undefined : trimmedExternalId;
    title = trimmedTitle;
    const trimmedDesc = options.description?.trim();
    description = trimmedDesc === '' ? undefined : trimmedDesc;
    const trimmedLink = options.link?.trim();
    link = trimmedLink === '' ? undefined : trimmedLink;
    projectName = trimmedProject;
  } else {
    // Interactive mode (default): prompt for missing params, use provided values as defaults

    // Show project selector
    const projects = await listProjects();

    if (projects.length === 0) {
      showEmpty('projects', 'Add one first with: ralphctl project add');
      return;
    }

    const defaultProjectIndex = options.project ? projects.findIndex((p) => p.name === options.project) : -1;

    projectName = await select({
      message: `${icons.project} Project:`,
      default: defaultProjectIndex >= 0 ? defaultProjectIndex : 0,
      choices: projects.map((p) => ({
        name: `${icons.project} ${p.name} ${muted(`- ${p.displayName}`)}`,
        value: p.name,
      })),
    });

    externalId = await input({
      message: `${icons.info} External ID (optional, e.g., JIRA-123):`,
      default: options.externalId?.trim(),
    });

    title = await input({
      message: `${icons.ticket} Title:`,
      default: options.title?.trim(),
      validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
    });

    if (useEditor) {
      // Use external editor via dynamic import
      const { editor } = await import('@inquirer/prompts');
      description = await editor({
        message: `${icons.edit} Description (opens editor):`,
        default: options.description?.trim(),
      });
    } else {
      description = await multilineInput({
        message: 'Description (recommended):',
        default: options.description?.trim(),
      });
    }

    link = await input({
      message: `${icons.info} Link (optional):`,
      default: options.link?.trim(),
      validate: (v) => {
        if (!v) return true;
        return validateUrl(v) ? true : 'Invalid URL format';
      },
    });

    const trimmedExternalId = externalId.trim();
    externalId = trimmedExternalId === '' ? undefined : trimmedExternalId;
    title = title.trim();
    const trimmedDescription = description.trim();
    description = trimmedDescription === '' ? undefined : trimmedDescription;
    const trimmedLinkInteractive = link.trim();
    link = trimmedLinkInteractive === '' ? undefined : trimmedLinkInteractive;
  }

  try {
    const ticket = await addTicket({
      externalId,
      title,
      description,
      link,
      projectName,
    });

    showSuccess('Ticket added!', [
      ['ID', ticket.id],
      ['Title', ticket.title],
      ['Project', ticket.projectName],
    ]);

    if (ticket.externalId) {
      console.log(field('External', ticket.externalId));
    }
    if (ticket.description) {
      console.log(fieldMultiline('Description', ticket.description));
    }
    if (ticket.link) {
      console.log(field('Link', ticket.link));
    }
    console.log('');
  } catch (err) {
    if (err instanceof DuplicateTicketError) {
      showError(`Ticket with external ID "${externalId ?? ''}" already exists`);
      showNextStep('ralphctl ticket list', 'see existing tickets');
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
    } else if (err instanceof Error && err.message.includes('does not exist')) {
      showError(err.message);
    } else {
      throw err;
    }
  }
}
