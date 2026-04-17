/**
 * SetCurrentSprintView — native Ink flow for `sprint current -` (select form).
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/application/bootstrap.ts';
import { listSprints } from '@src/integration/persistence/sprint.ts';
import { setCurrentSprint } from '@src/integration/persistence/config.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Set Current Sprint' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'loading' }
  | { kind: 'no-candidates' }
  | { kind: 'running' }
  | { kind: 'done'; id: string; name: string }
  | { kind: 'error'; message: string };

export function SetCurrentSprintView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'loading' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const sprints = await listSprints();
      const candidates = sprints.filter((s) => s.status === 'draft' || s.status === 'active');
      if (candidates.length === 0) {
        setPhase({ kind: 'no-candidates' });
        return;
      }

      setPhase({ kind: 'running' });
      const selectedId = await getPrompt().select<string>({
        message: 'Select current sprint:',
        choices: candidates.map((s) => ({
          label: `${s.id} — ${s.name} (${s.status})`,
          value: s.id,
        })),
      });

      await setCurrentSprint(selectedId);
      const chosen = candidates.find((s) => s.id === selectedId);
      setPhase({ kind: 'done', id: selectedId, name: chosen?.name ?? selectedId });
    },
  });

  const running = phase.kind === 'loading' || phase.kind === 'running';
  const hints = useMemo(() => (running ? HINTS_RUNNING : HINTS_DONE), [running]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading sprints…" />;
    case 'running':
      return <Spinner label="Awaiting sprint selection…" />;
    case 'no-candidates':
      return (
        <ResultCard
          kind="info"
          title="No draft or active sprints to choose from"
          lines={['Create a sprint from Home first.']}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not set current sprint" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Current sprint set"
          fields={[
            ['ID', phase.id],
            ['Name', phase.name],
          ]}
        />
      );
  }
}
