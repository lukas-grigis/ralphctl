/**
 * TaskImportView — native Ink wrapper around the plain-CLI `task import`.
 *
 * The underlying command reads a JSON file path from the user and imports
 * tasks with dependency validation. For now the view delegates to the CLI
 * command via `withSuspendedTui` — a dedicated inline file picker can come
 * in a later pass.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/application/bootstrap.ts';
import { withSuspendedTui } from '@src/integration/ui/tui/runtime/suspend.ts';
import { taskImportCommand } from '@src/integration/cli/commands/task/import.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Import Tasks' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'path' | 'importing' }
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export function TaskImportView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'path' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      setPhase({ kind: 'running', step: 'path' });
      const path = await prompt.input({
        message: 'Path to tasks JSON:',
        validate: (v: string) => (v.trim().length > 0 ? true : 'Path is required'),
      });

      setPhase({ kind: 'running', step: 'importing' });
      await withSuspendedTui(() => taskImportCommand([path.trim()]));
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
      return <Spinner label={phase.step === 'path' ? 'Awaiting JSON file path…' : 'Importing tasks…'} />;
    case 'done':
      return <ResultCard kind="success" title="Import finished" lines={['Check the task list to see the result.']} />;
    case 'cancelled':
      return <ResultCard kind="info" title="Import cancelled" />;
    case 'error':
      return <ResultCard kind="error" title="Import failed" lines={[phase.message]} />;
  }
}
