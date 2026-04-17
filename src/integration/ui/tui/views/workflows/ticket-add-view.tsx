/**
 * TicketAddView — native Ink flow for `ticket add`.
 *
 * Flow: (optional) link → fetch-issue-if-URL → title (prefilled)
 * → (optional) description (multi-line editor, prefilled) → commit → ResultCard.
 *
 * Project is inherited from `sprint.projectId` — no prompt needed.
 * Requires a current draft sprint — otherwise aborts with an explanatory
 * ResultCard before any prompt fires.
 */

import React, { useMemo } from 'react';
import type { Project, Ticket } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { addTicket } from '@src/integration/persistence/ticket.ts';
import { fetchIssueFromUrl, type IssueData } from '@src/integration/external/issue-fetch.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Add Ticket' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'link' | 'fetching' | 'title' | 'description' | 'saving' }
  | { kind: 'no-project' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; ticket: Ticket; project: Project; prefilled: boolean }
  | { kind: 'error'; message: string };

const STEP_LABEL: Record<Extract<Phase, { kind: 'running' }>['step'], string> = {
  link: 'Awaiting issue link…',
  fetching: 'Fetching issue data…',
  title: 'Awaiting ticket title…',
  description: 'Awaiting ticket description…',
  saving: 'Saving ticket…',
};

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function tryFetchIssue(url: string): IssueData | null {
  try {
    return fetchIssueFromUrl(url);
  } catch {
    return null;
  }
}

export function TicketAddView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'link' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      // Project inherited from sprint — defensively guard against missing.
      let project: Project;
      try {
        project = await getProjectById(sprint.projectId);
      } catch {
        setPhase({ kind: 'no-project' });
        return;
      }

      setPhase({ kind: 'running', step: 'link' });
      const link = await prompt.input({
        message: 'Issue link (optional):',
        validate: (v: string) => {
          const trimmed = v.trim();
          if (trimmed.length === 0) return true;
          return isValidUrl(trimmed) ? true : 'Must be a valid URL (or leave blank)';
        },
      });
      const trimmedLink = link.trim();

      let prefill: IssueData | null = null;
      if (trimmedLink.length > 0) {
        setPhase({ kind: 'running', step: 'fetching' });
        prefill = tryFetchIssue(trimmedLink);
      }

      setPhase({ kind: 'running', step: 'title' });
      const title = await prompt.input({
        message: 'Title:',
        default: prefill?.title,
        validate: (v: string) => (v.trim().length > 0 ? true : 'Title is required'),
      });

      setPhase({ kind: 'running', step: 'description' });
      const description = await prompt.editor({
        message: 'Description (recommended)',
        default: prefill?.body,
      });

      setPhase({ kind: 'running', step: 'saving' });
      const trimmedDescription = description?.trim() ?? '';
      const ticket = await addTicket({
        title: title.trim(),
        description: trimmedDescription.length > 0 ? trimmedDescription : undefined,
        link: trimmedLink.length > 0 ? trimmedLink : undefined,
      });

      setPhase({ kind: 'done', ticket, project, prefilled: prefill !== null });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={STEP_LABEL[phase.step]} />;
    case 'no-draft-sprint':
      return (
        <ResultCard
          kind="warning"
          title="Current sprint is not a draft"
          lines={['Only draft sprints accept new tickets.']}
          nextSteps={[{ action: 'Create a fresh draft sprint', description: 'Browse → Sprints → Create' }]}
        />
      );
    case 'no-project':
      return (
        <ResultCard
          kind="warning"
          title="Sprint's project could not be resolved"
          lines={['The sprint references a project that no longer exists.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not add ticket" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title={phase.prefilled ? 'Ticket added (prefilled from issue)' : 'Ticket added'}
          fields={[
            ['ID', phase.ticket.id],
            ['Title', phase.ticket.title],
            ['Project', `${phase.project.displayName} (${phase.project.name})`],
            ['Status', `requirement: ${phase.ticket.requirementStatus}`],
          ]}
          nextSteps={[{ action: 'Refine requirements', description: 'Home → Next: Refine Requirements' }]}
        />
      );
  }
}
