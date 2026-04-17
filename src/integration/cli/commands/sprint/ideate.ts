import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { editorInput } from '@src/integration/ui/prompts/editor-input.ts';
import {
  field,
  icons,
  log,
  printHeader,
  showError,
  showNextStep,
  showSuccess,
  showWarning,
  terminalBell,
} from '@src/integration/ui/theme/ui.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { providerDisplayName, resolveProvider } from '@src/integration/external/provider.ts';
import { getPrompt, getSharedDeps } from '@src/integration/bootstrap.ts';
import { createIdeatePipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { renderParsedTasksTable } from './plan-utils.ts';

interface IdeateOptions {
  auto: boolean;
  allPaths: boolean;
  project?: string;
}

function parseArgs(args: string[]): { sprintId?: string; options: IdeateOptions } {
  const options: IdeateOptions = {
    auto: false,
    allPaths: false,
  };
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '--all-paths') {
      options.allPaths = true;
    } else if (arg === '--project') {
      options.project = nextArg;
      i++;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

export async function sprintIdeateCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showNextStep('ralphctl sprint create', 'create a new sprint');
    log.newline();
    return;
  }
  const id = idR.value;

  const sprint = await getSprint(id);

  // Check if projects exist
  const projects = await listProjects();
  if (projects.length === 0) {
    showWarning('No projects configured.');
    showNextStep('ralphctl project add', 'add a project first');
    log.newline();
    return;
  }

  printHeader('Quick Ideation', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Mode', options.auto ? 'Auto (headless)' : 'Interactive'));
  log.newline();

  // Resolve project name
  let projectName = options.project;
  if (!projectName) {
    if (projects.length === 1) {
      projectName = projects[0]?.name;
      console.log(field('Project', projectName ?? '(unknown)'));
    } else {
      projectName = await getPrompt().select({
        message: 'Select project:',
        choices: projects.map((p) => ({ label: p.displayName, value: p.name })),
      });
    }
  }

  if (!projectName) {
    showError('No project selected.');
    log.newline();
    return;
  }

  // Collect idea
  const ideaTitle = await getPrompt().input({
    message: 'Idea title (short summary):',
    validate: (value) => (value.trim().length > 0 ? true : 'Title is required'),
  });

  const editorR = await editorInput({
    message: 'Idea description (what you want to build):',
  });
  if (!editorR.ok) {
    showError(`Editor input failed: ${editorR.error.message}`);
    log.newline();
    return;
  }
  const ideaDescription = editorR.value;

  if (!ideaDescription.trim()) {
    showError('Description is required.');
    log.newline();
    return;
  }

  log.newline();

  // Resolve provider for display
  const providerName = providerDisplayName(await resolveProvider());
  console.log(field('Provider', providerName));

  // Execute the ideate pipeline (load-sprint → assert-draft →
  // assert-project-provided → run-ideation → reorder-dependencies). The
  // idea payload is closed over — the CLI collected it via prompts above,
  // so the pipeline factory takes it as a constructor parameter rather
  // than threading it through context.
  const shared = getSharedDeps();
  const pipeline = createIdeatePipeline(
    shared,
    { title: ideaTitle, description: ideaDescription },
    {
      auto: options.auto,
      allPaths: options.allPaths,
      project: projectName,
    }
  );
  const result = await executePipeline(pipeline, { sprintId: id });

  if (!result.ok) {
    showError(result.error.message);
    log.newline();
    return;
  }

  const summary = result.value.context.ideaSummary;
  if (!summary) {
    showError('Ideation completed without producing a summary.');
    log.newline();
    return;
  }

  console.log(field('Ticket ID', summary.ticketId));

  if (summary.requirements === '') {
    showWarning('AI output was a bare tasks array — requirements not captured.');
  }

  // Show imported tasks
  const tasks = await listTasks(id);
  if (tasks.length > 0) {
    showSuccess(`Imported ${String(summary.importedTasks)} task(s).`);
    log.newline();
    console.log(
      renderParsedTasksTable(
        tasks.map((t) => ({
          name: t.name,
          description: t.description,
          steps: t.steps,
          verificationCriteria: t.verificationCriteria,
          repoId: t.repoId,
          ticketId: t.ticketId,
          blockedBy: t.blockedBy,
        }))
      )
    );
    console.log('');
  }

  log.dim('Tasks reordered by dependencies.');

  terminalBell();
  showNextStep('ralphctl sprint start', 'start executing tasks');
  log.newline();
}

// Re-export parseIdeateOutput for tests — logic now lives in output-parser adapter,
// but tests import from this module
import { Result } from 'typescript-result';
import { IdeateOutputSchema } from '@src/domain/models.ts';
import { extractJsonArray, extractJsonObject } from '@src/integration/utils/json-extract.ts';

export function parseIdeateOutput(output: string): { requirements: string; tasks: unknown[] } {
  const firstBrace = output.indexOf('{');
  const firstBracket = output.indexOf('[');
  const objectFirst = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);

  if (objectFirst) {
    return parseIdeateObject(output);
  }

  if (firstBracket !== -1) {
    const arrayR = Result.try(() => extractJsonArray(output));
    if (arrayR.ok) {
      const parseR = Result.try(() => JSON.parse(arrayR.value) as unknown);
      if (parseR.ok && Array.isArray(parseR.value)) {
        return { requirements: '', tasks: parseR.value as unknown[] };
      }
    }
  }

  throw new Error('No valid ideate output found — expected { requirements, tasks } object or a tasks array');
}

function parseIdeateObject(output: string): { requirements: string; tasks: unknown[] } {
  const jsonStr = extractJsonObject(output);
  const parsed = JSON.parse(jsonStr) as unknown;

  const result = IdeateOutputSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  if (typeof parsed === 'object' && parsed !== null && 'tasks' in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj['tasks'])) {
      const requirements = typeof obj['requirements'] === 'string' ? obj['requirements'] : '';
      return { requirements, tasks: obj['tasks'] as unknown[] };
    }
  }

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `[${issue.path.join('.')}]` : '';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
  throw new Error(`Invalid ideate output format:\n${issues}`);
}
