/**
 * RequirementsExportView — writes `<sprintDir>/requirements.md` for the
 * current sprint and shows the resulting path.
 */

import { join } from 'node:path';
import React, { useMemo } from 'react';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { getSprintDir } from '@src/integration/persistence/paths.ts';
import { exportRequirementsToMarkdown } from '@src/integration/persistence/requirements-export.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Export Requirements' as const;

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
  | { kind: 'empty' }
  | { kind: 'no-approved' }
  | { kind: 'done'; path: string; sprintName: string; total: number; approved: number }
  | { kind: 'error'; message: string };

export function RequirementsExportView({ sprintId }: Props): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const id = await resolveSprintId(sprintId);
      const sprint = await getSprint(id);

      if (sprint.tickets.length === 0) {
        setPhase({ kind: 'empty' });
        return;
      }
      const approved = sprint.tickets.filter((t) => t.requirementStatus === 'approved');
      if (approved.length === 0) {
        setPhase({ kind: 'no-approved' });
        return;
      }

      const outputPath = join(getSprintDir(id), 'requirements.md');
      await exportRequirementsToMarkdown(sprint, outputPath);

      setPhase({
        kind: 'done',
        path: outputPath,
        sprintName: sprint.name,
        total: sprint.tickets.length,
        approved: approved.length,
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
      return <Spinner label="Writing requirements.md…" />;
    case 'empty':
      return (
        <ResultCard
          kind="warning"
          title="No tickets in this sprint"
          nextSteps={[{ action: 'Add tickets', description: 'Browse → Tickets → Add' }]}
        />
      );
    case 'no-approved':
      return (
        <ResultCard
          kind="warning"
          title="No approved requirements to export"
          lines={['Run Refine first to approve ticket requirements.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not export" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Requirements exported"
          fields={[
            ['Sprint', phase.sprintName],
            ['Approved', `${String(phase.approved)}/${String(phase.total)} tickets`],
            ['File', phase.path],
          ]}
        />
      );
  }
}
