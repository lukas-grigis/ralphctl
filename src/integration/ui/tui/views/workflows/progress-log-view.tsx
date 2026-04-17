/**
 * ProgressLogView — native Ink flow for appending a progress entry.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/application/bootstrap.ts';
import { logProgress } from '@src/integration/persistence/progress.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Log Progress' as const;

const HINTS_RUNNING = [
  { key: 'Ctrl+D', action: 'submit' },
  { key: 'Esc', action: 'cancel' },
] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'message' | 'saving' }
  | { kind: 'cancelled' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export function ProgressLogView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'message' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      setPhase({ kind: 'running', step: 'message' });
      const text = await getPrompt().editor({
        message: 'Progress note',
      });
      const trimmed = text?.trim() ?? '';
      if (trimmed.length === 0) {
        setPhase({ kind: 'cancelled' });
        return;
      }
      setPhase({ kind: 'running', step: 'saving' });
      await logProgress(trimmed);
      setPhase({ kind: 'done' });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={phase.step === 'message' ? 'Awaiting progress note…' : 'Saving progress note…'} />;
    case 'cancelled':
      return <ResultCard kind="info" title="No note recorded" />;
    case 'error':
      return <ResultCard kind="error" title="Could not log progress" lines={[phase.message]} />;
    case 'done':
      return <ResultCard kind="success" title="Progress logged" />;
  }
}
