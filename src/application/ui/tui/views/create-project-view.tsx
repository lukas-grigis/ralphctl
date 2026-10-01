/**
 * Create-project wizard: name → slug → description → repository → repo name → confirm → save.
 * Prompts render inline (this view is a sequence of prompts) and claim keyboard focus only while
 * one is on screen, so `h` / `esc` still work on the saving and error states. A draft outlives
 * the step so going back (or returning from a storage error) keeps every earlier value.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
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
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createProject } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';

type StepKind = 'name' | 'slug' | 'description' | 'repo-path' | 'repo-name' | 'confirm';
type Step =
  | { readonly kind: StepKind }
  | { readonly kind: 'saving' }
  | { readonly kind: 'error'; readonly message: string; readonly returnTo: StepKind };

interface Draft {
  readonly name: string;
  readonly slug: string | undefined;
  readonly description: string;
  readonly repoPath: string;
  readonly repoName: string | undefined;
}

const EMPTY_DRAFT: Draft = { name: '', slug: undefined, description: '', repoPath: '', repoName: undefined };

/** Lightweight `~` expansion; an embedded `~` is left for the AbsolutePath validator. */
const expandHome = (input: string): string => {
  if (input === '~') return osHomedir();
  if (input.startsWith('~/')) return join(osHomedir(), input.slice(2));
  return input;
};

const BACK: Readonly<Record<StepKind, StepKind | undefined>> = {
  name: undefined,
  slug: 'name',
  description: 'slug',
  'repo-path': 'description',
  'repo-name': 'repo-path',
  confirm: 'repo-name',
};

const validateName = (value: string): string | undefined =>
  value.trim().length === 0 ? 'Name is required' : undefined;

const validateSlug = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Slug.parse(trimmed);
  if (parsed.ok) return undefined;
  const suggestion = toKebabCase(trimmed);
  return suggestion.length > 0 && suggestion !== trimmed
    ? `${parsed.error.message} — try ${suggestion}`
    : parsed.error.message;
};

interface Update {
  readonly patch: Partial<Draft>;
  readonly next: StepKind;
}

export const CreateProjectView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const [step, setStep] = useState<Step>({ kind: 'name' });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  // Claim only while a prompt is rendered — saving / error have no prompt, so global keys must work.
  const { claimPrompt, claimEscape } = ui;
  const prompting = step.kind !== 'saving' && step.kind !== 'error';
  useEffect(() => (prompting ? claimPrompt() : undefined), [claimPrompt, prompting]);
  // The error step owns esc locally; without the claim the global pop would also fire.
  const onError = step.kind === 'error';
  useEffect(() => (onError ? claimEscape() : undefined), [claimEscape, onError]);

  // At the stack root (first run) there is nothing to pop to: leave for Work instead.
  const leave = (): void => {
    if (router.stack.length <= 1) router.reset({ id: 'home' });
    else router.pop();
  };

  const advance = ({ patch, next }: Update): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setStep({ kind: next });
  };

  const goBack = (kind: StepKind, patch: Partial<Draft> = {}): void => {
    setDraft((d) => ({ ...d, ...patch }));
    const prev = BACK[kind];
    if (prev === undefined) leave();
    else setStep({ kind: prev });
  };

  const fail = (message: string, returnTo: StepKind): void => setStep({ kind: 'error', message, returnTo });

  const submit = async (): Promise<void> => {
    setStep({ kind: 'saving' });

    const pathResult = AbsolutePath.parse(expandHome(draft.repoPath.trim()));
    if (!pathResult.ok) return fail(`repo path: ${pathResult.error.message}`, 'repo-path');

    const repoNameTrim = (draft.repoName ?? '').trim();
    const repoResult = createRepository({
      path: pathResult.value,
      ...(repoNameTrim.length > 0 ? { name: repoNameTrim } : {}),
    });
    if (!repoResult.ok) return fail(`repo: ${repoResult.error.message}`, 'repo-name');

    const slugTrim = (draft.slug ?? '').trim();
    const slugInput = slugTrim.length > 0 ? Slug.parse(slugTrim) : undefined;
    if (slugInput !== undefined && !slugInput.ok) return fail(`slug: ${slugInput.error.message}`, 'slug');

    const projectResult = createProject({
      displayName: draft.name.trim(),
      ...(slugInput !== undefined && slugInput.ok ? { slug: slugInput.value } : {}),
      ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : {}),
      repositories: [repoResult.value],
    });
    if (!projectResult.ok) return fail(projectResult.error.message, 'name');

    const saved = await deps.projectRepo.save(projectResult.value);
    if (!saved.ok) return fail(saved.error.message, 'confirm');

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
          <StepView
            step={step}
            draft={draft}
            onAdvance={advance}
            onBack={goBack}
            onRetry={(kind) => setStep({ kind })}
            onSubmit={() => void submit()}
          />
        </Box>
      </Box>
    </ViewShell>
  );
};

interface StepViewProps {
  readonly step: Step;
  readonly draft: Draft;
  readonly onAdvance: (update: Update) => void;
  readonly onBack: (kind: StepKind, patch?: Partial<Draft>) => void;
  readonly onRetry: (kind: StepKind) => void;
  readonly onSubmit: () => void;
}

const ConfirmStep = ({
  draft,
  onSubmit,
  onBack,
}: {
  readonly draft: Draft;
  readonly onSubmit: () => void;
  readonly onBack: () => void;
}): React.JSX.Element => {
  const slug = (draft.slug ?? '').trim();
  const repoName = (draft.repoName ?? '').trim();
  return (
    <Box flexDirection="column">
      <FieldList
        fields={[
          { label: 'Name', value: <Text bold>{draft.name}</Text> },
          { label: 'Slug', value: slug.length > 0 ? slug : toKebabCase(draft.name) },
          ...(draft.description.trim().length > 0 ? [{ label: 'Description', value: draft.description }] : []),
          { label: 'Repo path', value: <Text dimColor>{expandHome(draft.repoPath)}</Text> },
          { label: 'Repo name', value: repoName.length > 0 ? repoName : basename(expandHome(draft.repoPath)) },
        ]}
      />
      <Box marginTop={spacing.section}>
        <ConfirmPrompt
          message="Save this project?"
          onSubmit={(value) => {
            if (value) onSubmit();
            else onBack();
          }}
          onCancel={onBack}
        />
      </Box>
    </Box>
  );
};

/** Submit-time failures (storage, mostly): esc or ↵ returns to the failing step, values intact. */
const ErrorStep = ({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element => {
  useInput((_input, key) => {
    if (key.escape || key.return) onRetry();
  });
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.error}>
        {glyphs.cross} {message}
      </Text>
      <Text dimColor>↵ or esc to go back and fix it · h Work</Text>
    </Box>
  );
};

const StepView = ({ step, draft, onAdvance, onBack, onRetry, onSubmit }: StepViewProps): React.JSX.Element => {
  // Per-step `key` gives each prompt a fresh buffer seeded from the draft.
  switch (step.kind) {
    case 'name':
      return (
        <TextPrompt
          key="name"
          message="Project display name"
          initial={draft.name}
          validate={validateName}
          escLabel="Work"
          onSubmit={(value) => onAdvance({ patch: { name: value.trim() }, next: 'slug' })}
          onCancel={() => onBack('name')}
        />
      );
    case 'slug':
      return (
        <TextPrompt
          key="slug"
          message="Project slug (kebab-case, blank for default)"
          initial={draft.slug ?? toKebabCase(draft.name)}
          validate={validateSlug}
          preview={(v) =>
            v.trim().length === 0 ? `blank saves as ${toKebabCase(draft.name)}` : `saves as ${v.trim()}`
          }
          escLabel="back"
          onSubmit={(value) => onAdvance({ patch: { slug: value }, next: 'description' })}
          onCancel={() => onBack('slug')}
        />
      );
    case 'description':
      return (
        <TextPrompt
          key="description"
          message="Description (optional, Enter to skip)"
          initial={draft.description}
          escLabel="back"
          onSubmit={(value) => onAdvance({ patch: { description: value }, next: 'repo-path' })}
          onCancel={() => onBack('description')}
        />
      );
    case 'repo-path':
      return (
        <PathPickerPrompt
          key="repo-path"
          message="Repository directory"
          {...(draft.repoPath.length > 0 ? { initial: draft.repoPath } : {})}
          onSubmit={(value) => onAdvance({ patch: { repoPath: value }, next: 'repo-name' })}
          onCancel={() => onBack('repo-path')}
        />
      );
    case 'repo-name':
      return (
        <TextPrompt
          key="repo-name"
          message="Repository name (blank for default)"
          initial={draft.repoName ?? basename(expandHome(draft.repoPath))}
          escLabel="back"
          onSubmit={(value) => onAdvance({ patch: { repoName: value }, next: 'confirm' })}
          onCancel={() => onBack('repo-name')}
        />
      );
    case 'confirm':
      return <ConfirmStep draft={draft} onSubmit={onSubmit} onBack={() => onBack('confirm')} />;
    case 'saving':
      return <Spinner label="saving project…" />;
    case 'error':
      return <ErrorStep message={step.message} onRetry={() => onRetry(step.returnTo)} />;
  }
};
