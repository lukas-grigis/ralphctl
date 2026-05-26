/**
 * Create-project view — interactive wizard for assembling a new {@link Project} aggregate.
 *
 * Walks the user through:
 *   1. Project display name (required)
 *   2. Project slug (defaults to kebab-case(name); editable)
 *   3. Project description (optional, blank to skip)
 *   4. First repository path (required, absolute; `~/` is expanded against `os.homedir()`)
 *   5. First repository name (defaults to basename(path))
 *   6. Confirm → save via `projectRepo.save`, stamp the new id as current, then route home.
 *
 * Mirrors the welcome-view embedding style: prompts are rendered inline rather than going
 * through the prompt queue, since this view *is* a sequence of prompts and has nothing else
 * competing for keyboard focus.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { homedir as osHomedir } from 'node:os';
import { basename, join } from 'node:path';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { PathPickerPrompt } from '@src/application/ui/tui/prompts/path-picker-prompt.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { spacing, inkColors, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { createProject } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';

type Step =
  | { readonly kind: 'name' }
  | { readonly kind: 'slug'; readonly name: string }
  | { readonly kind: 'description'; readonly name: string; readonly slug: string }
  | {
      readonly kind: 'repo-path';
      readonly name: string;
      readonly slug: string;
      readonly description: string;
    }
  | {
      readonly kind: 'repo-name';
      readonly name: string;
      readonly slug: string;
      readonly description: string;
      readonly repoPath: string;
    }
  | {
      readonly kind: 'confirm';
      readonly name: string;
      readonly slug: string;
      readonly description: string;
      readonly repoPath: string;
      readonly repoName: string;
    }
  | { readonly kind: 'saving' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Lightweight `~` expansion: only the leading `~` followed by `/` or end-of-string is treated
 * as the home directory. Embedded `~` in the middle of a path is left alone so the
 * AbsolutePath validator can surface it.
 */
const expandHome = (input: string): string => {
  if (input === '~') return osHomedir();
  if (input.startsWith('~/')) return join(osHomedir(), input.slice(2));
  return input;
};

/**
 * Previous step for the current one. Used as the `esc` target so the user can fix a typo
 * without starting the wizard over. Returns `undefined` on the first step (esc cancels the
 * wizard entirely) and on the terminal states.
 */
const backStep = (step: Step): Step | undefined => {
  switch (step.kind) {
    case 'name':
      return undefined;
    case 'slug':
      return { kind: 'name' };
    case 'description':
      return { kind: 'slug', name: step.name };
    case 'repo-path':
      return { kind: 'description', name: step.name, slug: step.slug };
    case 'repo-name':
      return {
        kind: 'repo-path',
        name: step.name,
        slug: step.slug,
        description: step.description,
      };
    case 'confirm':
      return {
        kind: 'repo-name',
        name: step.name,
        slug: step.slug,
        description: step.description,
        repoPath: step.repoPath,
      };
    case 'saving':
    case 'error':
      return undefined;
  }
};

export const CreateProjectView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const [step, setStep] = useState<Step>({ kind: 'name' });

  // The wizard owns input focus end-to-end; suspend global keybindings so `n`/`s`/etc don't
  // hijack characters the user is typing into the prompt.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => claimPrompt(), [claimPrompt]);

  const cancel = (): void => router.pop();

  const submit = async (s: Extract<Step, { kind: 'confirm' }>): Promise<void> => {
    setStep({ kind: 'saving' });

    const expandedPath = expandHome(s.repoPath.trim());
    const pathResult = AbsolutePath.parse(expandedPath);
    if (!pathResult.ok) {
      setStep({ kind: 'error', message: `repo path: ${pathResult.error.message}` });
      return;
    }

    const repoNameTrim = s.repoName.trim();
    const repoResult = createRepository({
      path: pathResult.value,
      ...(repoNameTrim.length > 0 ? { name: repoNameTrim } : {}),
    });
    if (!repoResult.ok) {
      setStep({ kind: 'error', message: `repo: ${repoResult.error.message}` });
      return;
    }

    const slugInput = s.slug.trim().length > 0 ? Slug.parse(s.slug.trim()) : undefined;
    if (slugInput !== undefined && !slugInput.ok) {
      setStep({ kind: 'error', message: `slug: ${slugInput.error.message}` });
      return;
    }

    const projectResult = createProject({
      displayName: s.name.trim(),
      ...(slugInput !== undefined && slugInput.ok ? { slug: slugInput.value } : {}),
      ...(s.description.trim().length > 0 ? { description: s.description.trim() } : {}),
      repositories: [repoResult.value],
    });
    if (!projectResult.ok) {
      setStep({ kind: 'error', message: projectResult.error.message });
      return;
    }

    const saved = await deps.projectRepo.save(projectResult.value);
    if (!saved.ok) {
      setStep({ kind: 'error', message: saved.error.message });
      return;
    }

    selection.setProject(projectResult.value.id, projectResult.value.displayName);
    router.reset({ id: 'home' });
  };

  return (
    <ViewShell title="Create project" subtitle="One project ties together repositories and sprints.">
      <Box flexDirection="column">
        <Card title="What we'll collect" tone="rule">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text dimColor>
              {glyphs.bullet} a display name and short slug
              {'\n'}
              {glyphs.bullet} an optional description
              {'\n'}
              {glyphs.bullet} the absolute path of at least one repository
            </Text>
          </Box>
        </Card>
        <Box marginTop={spacing.section} flexDirection="column">
          <StepView step={step} onChange={setStep} onCancel={cancel} onSubmit={submit} />
        </Box>
      </Box>
    </ViewShell>
  );
};

interface StepViewProps {
  readonly step: Step;
  readonly onChange: (next: Step) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (s: Extract<Step, { kind: 'confirm' }>) => Promise<void>;
}

const StepView = ({ step, onChange, onCancel, onSubmit }: StepViewProps): React.JSX.Element => {
  // Per-step `key` so each TextPrompt is a fresh instance — otherwise React's reconciliation
  // preserves the previous step's buffer at the same tree position and the next field pre-fills
  // with the prior value.
  //
  // Esc on a non-first step steps back instead of exiting the wizard, so the user can fix a
  // typo at the confirm step without losing earlier input.
  const prev = backStep(step);
  const cancelOrBack = prev !== undefined ? (): void => onChange(prev) : onCancel;
  switch (step.kind) {
    case 'name':
      return (
        <TextPrompt
          key="name"
          message="Project display name"
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            onChange({ kind: 'slug', name: trimmed });
          }}
          onCancel={cancelOrBack}
        />
      );
    case 'slug':
      return (
        <TextPrompt
          key="slug"
          message="Project slug (kebab-case, blank for default)"
          initial={toKebabCase(step.name)}
          onSubmit={(value) => onChange({ kind: 'description', name: step.name, slug: value })}
          onCancel={cancelOrBack}
        />
      );
    case 'description':
      return (
        <TextPrompt
          key="description"
          message="Description (optional, Enter to skip)"
          onSubmit={(value) => onChange({ kind: 'repo-path', name: step.name, slug: step.slug, description: value })}
          onCancel={cancelOrBack}
        />
      );
    case 'repo-path':
      return (
        <PathPickerPrompt
          key="repo-path"
          message="Repository directory"
          onSubmit={(value) =>
            onChange({
              kind: 'repo-name',
              name: step.name,
              slug: step.slug,
              description: step.description,
              repoPath: value,
            })
          }
          onCancel={cancelOrBack}
        />
      );
    case 'repo-name': {
      const fallback = basename(expandHome(step.repoPath));
      return (
        <TextPrompt
          key="repo-name"
          message="Repository name (blank for default)"
          initial={fallback}
          onSubmit={(value) =>
            onChange({
              kind: 'confirm',
              name: step.name,
              slug: step.slug,
              description: step.description,
              repoPath: step.repoPath,
              repoName: value,
            })
          }
          onCancel={cancelOrBack}
        />
      );
    }
    case 'confirm':
      return (
        <Box flexDirection="column">
          <FieldList
            fields={[
              { label: 'Name', value: <Text bold>{step.name}</Text> },
              { label: 'Slug', value: step.slug.trim().length > 0 ? step.slug : toKebabCase(step.name) },
              ...(step.description.trim().length > 0 ? [{ label: 'Description', value: step.description }] : []),
              { label: 'Repo path', value: <Text dimColor>{expandHome(step.repoPath)}</Text> },
              {
                label: 'Repo name',
                value: step.repoName.trim().length > 0 ? step.repoName : basename(expandHome(step.repoPath)),
              },
            ]}
          />
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Save this project?"
              onSubmit={(value) => {
                if (value) void onSubmit(step);
                else cancelOrBack();
              }}
              onCancel={cancelOrBack}
            />
          </Box>
        </Box>
      );
    case 'saving':
      return <Spinner label="saving project…" />;
    case 'error':
      return (
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text color={inkColors.error}>✗ {step.message}</Text>
          <Text dimColor>Press esc to go back.</Text>
        </Box>
      );
  }
};
