/**
 * Field-group renderers for the project-detail view — the project info card and the per-repo
 * cards. Split out of `project-detail-view.tsx` so the orchestrator component and its hooks stay
 * the sole content of that file; rendering is identical to before the split.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { FeedbackLine } from '@src/application/ui/tui/components/feedback-line.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { Field } from '../project-detail-view.tsx';

/** Wrap a field value with the action-cursor glyph + primary color when focused. Mirrors the
 *  pattern from settings-view.tsx so the focus signal stays consistent across detail views. */
export const focusable = (focused: boolean, node: React.ReactNode): React.ReactNode => (
  <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
    {focused ? `${glyphs.actionCursor} ` : '  '}
    {node}
  </Text>
);

export const noneText = (
  <Text dimColor italic>
    (none)
  </Text>
);

export interface RepoCardProps {
  readonly repo: Repository;
  readonly focused: Field | undefined;
}

export const RepoCard = ({ repo, focused }: RepoCardProps): React.JSX.Element => {
  const repoFocused = focused?.kind === 'repo' && focused.repo.id === repo.id;
  const nameFocused = repoFocused && focused.field === 'name';
  const setupFocused = repoFocused && focused.field === 'setupScript';
  const verifyFocused = repoFocused && focused.field === 'verifyScript';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={inkColors.rule}
      paddingX={spacing.cardPadX}
      marginTop={spacing.section}
    >
      <Text bold {...(nameFocused ? { color: inkColors.primary } : {})}>
        {nameFocused ? `${glyphs.actionCursor} ` : '  '}
        {repo.name} <Text dimColor>({repo.slug})</Text>
      </Text>
      <FieldList
        fields={[
          { label: 'Path', value: <Text dimColor>{repo.path}</Text> },
          { label: 'Setup', value: focusable(setupFocused, repo.setupScript ?? noneText) },
          { label: 'Verify', value: focusable(verifyFocused, repo.verifyScript ?? noneText) },
        ]}
      />
    </Box>
  );
};

export interface BodyProps {
  readonly project: Project;
  readonly focused: Field | undefined;
  readonly feedback: string | undefined;
}

export const Body = ({ project, focused, feedback }: BodyProps): React.JSX.Element => {
  const projectNameFocused = focused?.kind === 'project';
  return (
    <Box flexDirection="column">
      <Card title="Project" tone="primary">
        <FieldList
          fields={[
            {
              label: 'Name',
              value: focusable(projectNameFocused, <Text bold>{project.displayName}</Text>),
            },
            { label: 'Slug', value: project.slug },
            { label: 'Id', value: <Text dimColor>{project.id}</Text> },
            ...(project.description !== undefined ? [{ label: 'Description', value: project.description }] : []),
            { label: 'Repositories', value: String(project.repositories.length) },
          ]}
        />
      </Card>
      <Box marginTop={spacing.section} flexDirection="column">
        <Text bold>{glyphs.badge} Repositories</Text>
        {project.repositories.map((repo) => (
          <RepoCard key={repo.id} repo={repo} focused={focused} />
        ))}
        {/* Key affordances are published through the router's hint strip (`useViewHints`), the
            single source of truth that gates the repo-only `d`/`c`/`S` chords on the focused row.
            An inline duplicate would re-advertise them ungated and contradict the gate. */}
        <FeedbackLine text={feedback} />
      </Box>
    </Box>
  );
};
