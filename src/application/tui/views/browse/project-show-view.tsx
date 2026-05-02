/**
 * ProjectShowView — detail view for a single project.
 *
 * Shows project metadata + repository list. Read-only. Press Esc to go back.
 *
 * Receives `projectName: string` via router props.
 */

import React, { useEffect, useState } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { FieldList } from '@src/application/tui/components/field-list.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouterOptional } from '@src/application/tui/views/router-context.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { ShowProjectUseCase } from '@src/business/usecases/project/show-project.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { Project } from '@src/domain/entities/project.ts';

const SHOW_HINTS = [
  { key: 'Esc', action: 'back' },
  { key: getKeyFor('detail.edit'), action: 'edit' },
  { key: getKeyFor('detail.addRepo'), action: 'add repo' },
  { key: getKeyFor('detail.removeRepo'), action: 'remove repo' },
] as const;

interface Props {
  readonly projectName?: string;
}

export function ProjectShowView({ projectName }: Props): React.JSX.Element {
  useViewHints(SHOW_HINTS);
  const router = useRouterOptional();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const KEY_EDIT = getKeyFor('detail.edit');
  const KEY_ADD_REPO = getKeyFor('detail.addRepo');
  const KEY_REMOVE_REPO = getKeyFor('detail.removeRepo');

  useViewInput((input) => {
    if (!project || !router) return;
    const name = String(project.name);
    if (input === KEY_EDIT) {
      router.push({ id: 'project-edit', props: { projectName: name } });
      return;
    }
    if (input === KEY_ADD_REPO) {
      router.push({ id: 'project-repo-add', props: { projectName: name } });
      return;
    }
    if (input === KEY_REMOVE_REPO) {
      router.push({ id: 'project-repo-remove', props: { projectName: name } });
    }
  });

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      if (!projectName) {
        setError('No project name provided.');
        return;
      }
      try {
        const nameResult = ProjectName.parse(projectName);
        if (!nameResult.ok) {
          setError(nameResult.error.message);
          return;
        }
        const deps = await getSharedDeps();
        const uc = new ShowProjectUseCase(deps.projectRepo);
        const result = await uc.execute({ name: nameResult.value });
        if (cancel.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setProject(result.value);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, [projectName]);

  if (project === null && error === null) {
    return (
      <ViewShell title="PROJECT">
        <Spinner label="Loading project…" />
      </ViewShell>
    );
  }

  if (error !== null) {
    return (
      <ViewShell title="PROJECT">
        <ResultCard
          kind="error"
          title="Project not found"
          lines={[error]}
          nextSteps={[{ action: 'Go back', description: 'press Esc' }]}
        />
      </ViewShell>
    );
  }

  if (project === null)
    return (
      <ViewShell title="PROJECT">
        <Box />
      </ViewShell>
    );

  const fields: [string, string][] = [
    ['Name', String(project.name)],
    ['Display', project.displayName],
    ...(project.description !== undefined ? [['Desc', project.description] as [string, string]] : []),
    ['Repos', String(project.repositories.length)],
  ];

  return (
    <ViewShell title="PROJECT">
      <Box flexDirection="column">
        <Text bold>{project.displayName}</Text>

        <Box marginTop={spacing.section}>
          <FieldList fields={fields} />
        </Box>

        {project.repositories.length > 0 ? (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              Repositories
            </Text>
            {project.repositories.map((repo) => {
              const onboarded = repo.onboardedAt !== null;
              const onboardedDate = onboarded ? repo.onboardedAt.slice(0, 10) : null;
              return (
                <Box key={repo.path} paddingLeft={spacing.indent} marginTop={0} flexDirection="column">
                  <Box>
                    <Text color={inkColors.muted}>{glyphs.bulletListItem} </Text>
                    <Text bold>{repo.name}</Text>
                    <Text dimColor>{`  ${glyphs.emDash} ${repo.path}`}</Text>
                    {onboarded ? (
                      <Text color={inkColors.success}>{`  ${glyphs.inlineDot} onboarded ${onboardedDate ?? ''}`}</Text>
                    ) : (
                      <Text color={inkColors.muted}>{`  ${glyphs.inlineDot} not onboarded`}</Text>
                    )}
                  </Box>
                  {repo.checkScript !== undefined ? (
                    <Box paddingLeft={spacing.indent + 2}>
                      <Text dimColor>{`check: ${repo.checkScript}`}</Text>
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ) : null}
      </Box>
    </ViewShell>
  );
}
