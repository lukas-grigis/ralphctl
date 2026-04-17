/**
 * ProjectShowView — detail card for a project.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Project } from '@src/domain/models.ts';
import { getProject } from '@src/integration/persistence/project.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { FieldList } from '@src/integration/ui/tui/components/field-list.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly projectName?: string;
}

type State = { kind: 'loading' } | { kind: 'ready'; project: Project } | { kind: 'error'; message: string };

const TITLE = 'Project Details' as const;
const HINTS = [] as const;

export function ProjectShowView({ projectName }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      if (!projectName) {
        setState({ kind: 'error', message: 'No project name provided' });
        return;
      }
      try {
        const project = await getProject(projectName);
        if (!ctl.cancelled) setState({ kind: 'ready', project });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [projectName]);

  return <ViewShell title={TITLE}>{renderBody(state)}</ViewShell>;
}

function renderBody(state: State): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading project…" />;
  if (state.kind === 'error') return <ResultCard kind="error" title="Could not load project" lines={[state.message]} />;

  const { project } = state;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{project.displayName}</Text>
        <Text dimColor>{`  (${project.name})`}</Text>
      </Box>
      <Box marginTop={spacing.section}>
        <FieldList
          fields={[
            ['Slug', project.name],
            ['Description', project.description ?? glyphs.emDash],
            ['Repos', String(project.repositories.length)],
          ]}
        />
      </Box>
      <Box marginTop={spacing.section} flexDirection="column">
        <Text color={inkColors.muted} bold>
          Repositories
        </Text>
        {project.repositories.map((r) => (
          <Box key={r.path} paddingLeft={spacing.indent}>
            <Text dimColor>{glyphs.bulletListItem} </Text>
            <Text>{r.name}</Text>
            <Text dimColor>{`  ${r.path}`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
