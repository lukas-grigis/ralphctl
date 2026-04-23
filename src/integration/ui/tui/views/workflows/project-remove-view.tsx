/**
 * ProjectRemoveView — native Ink flow for `project remove`.
 *
 * Selection happens here; the shared {@link RemovalWorkflow} owns the confirm
 * + remove + done state machine.
 */

import React, { useEffect, useState } from 'react';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { listProjects, removeProject } from '@src/integration/persistence/project.ts';
import { RemovalWorkflow } from '@src/integration/ui/tui/components/removal-workflow.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

const TITLE = 'Remove Project' as const;

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting' }
  | { kind: 'no-projects' }
  | { kind: 'ready'; name: string }
  | { kind: 'error'; message: string };

export function ProjectRemoveView(): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
        const projects = await listProjects();
        if (projects.length === 0) {
          setPhase({ kind: 'no-projects' });
          return;
        }
        setPhase({ kind: 'selecting' });
        const name = await getPrompt().select<string>({
          message: 'Select project to remove:',
          choices: projects.map((p) => ({
            label: `${p.displayName} (${p.name})`,
            value: p.name,
            description: `${String(p.repositories.length)} repo${p.repositories.length === 1 ? '' : 's'}`,
          })),
        });
        setPhase({ kind: 'ready', name });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          return;
        }
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [started, router]);

  if (phase.kind === 'ready') {
    return (
      <RemovalWorkflow
        entityLabel={TITLE}
        confirmMessage={`Remove project "${phase.name}"? This cannot be undone.`}
        onConfirm={() => removeProject(phase.name)}
        successMessage={`Project "${phase.name}" removed`}
        onDone={() => {
          router.pop();
        }}
      />
    );
  }

  return <ViewShell title={TITLE}>{renderPre(phase)}</ViewShell>;
}

function renderPre(phase: Exclude<Phase, { kind: 'ready' }>): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading projects…" />;
    case 'selecting':
      return <Spinner label="Awaiting project selection…" />;
    case 'no-projects':
      return <ResultCard kind="info" title="No projects to remove" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove project" lines={[phase.message]} />;
  }
}
