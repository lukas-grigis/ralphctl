/**
 * ContextExportView — writes `<sprintDir>/context.md` with a markdown
 * dump of the sprint (tickets grouped by project + tasks list). Unlike the
 * plain-CLI `sprint context` — which streams to stdout — this view persists
 * to disk so the user can open it in an editor.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import React, { useMemo } from 'react';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { getProjectById, getRepoById } from '@src/integration/persistence/project.ts';
import { formatTicketDisplay } from '@src/integration/persistence/ticket.ts';
import { getSprintDir } from '@src/integration/persistence/paths.ts';
import { ensureDir } from '@src/integration/persistence/storage.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';
import type { Sprint, Tasks } from '@src/domain/models.ts';

const TITLE = 'Export Context' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

interface Props {
  readonly sprintId?: string;
}

type Phase =
  | { kind: 'running' }
  | { kind: 'done'; path: string; sprintName: string; ticketCount: number; taskCount: number }
  | { kind: 'error'; message: string };

export function ContextExportView({ sprintId }: Props): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const id = await resolveSprintId(sprintId);
      const sprint = await getSprint(id);
      const tasks = await listTasks(id);
      const markdown = await renderContextMarkdown(sprint, tasks);

      const sprintDir = getSprintDir(id);
      await ensureDir(sprintDir);
      const outputPath = join(sprintDir, 'context.md');
      await writeFile(outputPath, markdown, 'utf8');

      setPhase({
        kind: 'done',
        path: outputPath,
        sprintName: sprint.name,
        ticketCount: sprint.tickets.length,
        taskCount: tasks.length,
      });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label="Writing context.md…" />;
    case 'error':
      return <ResultCard kind="error" title="Could not export context" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Context exported"
          fields={[
            ['Sprint', phase.sprintName],
            ['Tickets', String(phase.ticketCount)],
            ['Tasks', String(phase.taskCount)],
            ['File', phase.path],
          ]}
          lines={['Open in your editor or share with the AI provider.']}
        />
      );
  }
}

async function renderContextMarkdown(sprint: Sprint, tasks: Tasks): Promise<string> {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprint.name}`);
  lines.push(`ID: ${sprint.id}`);
  lines.push(`Status: ${sprint.status}`);
  lines.push('');
  lines.push('## Tickets');
  lines.push('');

  if (sprint.tickets.length === 0) {
    lines.push('_No tickets defined_');
  } else {
    const projectR = await wrapAsync(() => getProjectById(sprint.projectId), ensureError);
    const project = projectR.ok ? projectR.value : null;
    lines.push(`### Project: ${project ? `${project.displayName} (${project.name})` : sprint.projectId}`);
    if (project) {
      const repoPaths = project.repositories.map((r) => `${r.name} (${r.path})`);
      lines.push(`Repositories: ${repoPaths.join(', ')}`);
    } else {
      lines.push('Repositories: (project not found)');
    }
    lines.push('');

    for (const ticket of sprint.tickets) {
      const reqBadge = ticket.requirementStatus === 'approved' ? ' [approved]' : ' [pending]';
      lines.push(`#### ${formatTicketDisplay(ticket)}${reqBadge}`);
      if (ticket.description) {
        lines.push('');
        lines.push(ticket.description);
      }
      if (ticket.link) {
        lines.push('');
        lines.push(`Link: ${ticket.link}`);
      }
      if (ticket.requirements) {
        lines.push('');
        lines.push('**Refined Requirements:**');
        lines.push('');
        lines.push(ticket.requirements);
      }
      lines.push('');
    }
  }

  lines.push('## Tasks');
  lines.push('');
  if (tasks.length === 0) {
    lines.push('_No tasks defined yet_');
  } else {
    for (const task of tasks) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      lines.push(`### ${task.id}: ${task.name}${ticketRef}`);
      const repoR = await wrapAsync(() => getRepoById(task.repoId), ensureError);
      const repoLabel = repoR.ok ? `${repoR.value.repo.name} (${repoR.value.repo.path})` : task.repoId;
      lines.push(`Status: ${task.status} | Order: ${String(task.order)} | Repo: ${repoLabel}`);
      if (task.blockedBy.length > 0) {
        lines.push(`Blocked By: ${task.blockedBy.join(', ')}`);
      }
      if (task.description) {
        lines.push('');
        lines.push(task.description);
      }
      if (task.steps.length > 0) {
        lines.push('');
        lines.push('Steps:');
        task.steps.forEach((step, i) => {
          lines.push(`${String(i + 1)}. ${step}`);
        });
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}
