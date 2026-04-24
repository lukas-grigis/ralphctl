/**
 * ProjectRepoRemoveView — native Ink flow for `project repo remove`.
 *
 * Selection (project + repo) happens here; the shared {@link RemovalWorkflow}
 * owns the confirm + remove + done state machine.
 */

import React, { useEffect, useState } from 'react';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { listProjects, removeProjectRepo } from '@src/integration/persistence/project.ts';
import { RemovalWorkflow } from '@src/integration/ui/tui/components/removal-workflow.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

const TITLE = 'Remove Repository' as const;

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting-project' }
  | { kind: 'selecting-repo' }
  | { kind: 'no-projects' }
  | { kind: 'no-repos' }
  | { kind: 'ready'; projectName: string; projectDisplay: string; repoPath: string; repoName: string }
  | { kind: 'error'; message: string };

export function ProjectRepoRemoveView(): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
        const prompt = getPrompt();
        const projects = await listProjects();
        if (projects.length === 0) {
          setPhase({ kind: 'no-projects' });
          return;
        }

        setPhase({ kind: 'selecting-project' });
        const projectName =
          projects.length === 1 && projects[0]
            ? projects[0].name
            : await prompt.select<string>({
                message: 'Which project?',
                choices: projects.map((p) => ({ label: p.displayName, value: p.name })),
              });

        const project = projects.find((p) => p.name === projectName);
        if (!project || project.repositories.length === 0) {
          setPhase({ kind: 'no-repos' });
          return;
        }

        setPhase({ kind: 'selecting-repo' });
        const repoPath = await prompt.select<string>({
          message: 'Repository to remove:',
          choices: project.repositories.map((r) => ({ label: r.name, value: r.path, description: r.path })),
        });
        const repoName = project.repositories.find((r) => r.path === repoPath)?.name ?? repoPath;

        setPhase({
          kind: 'ready',
          projectName,
          projectDisplay: project.displayName,
          repoPath,
          repoName,
        });
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
        confirmMessage={`Remove repository "${phase.repoName}" from ${phase.projectDisplay}? This cannot be undone.`}
        onConfirm={async () => {
          await removeProjectRepo(phase.projectName, phase.repoPath);
        }}
        successMessage={`Repository "${phase.repoName}" removed from ${phase.projectDisplay}`}
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
    case 'selecting-project':
      return <Spinner label="Awaiting project selection…" />;
    case 'selecting-repo':
      return <Spinner label="Awaiting repository selection…" />;
    case 'no-projects':
      return <ResultCard kind="info" title="No projects" />;
    case 'no-repos':
      return <ResultCard kind="info" title="Project has no repositories" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove repository" lines={[phase.message]} />;
  }
}
