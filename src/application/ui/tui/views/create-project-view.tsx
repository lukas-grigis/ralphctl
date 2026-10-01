/** Create-project wizard: name → slug → description → repository → repo name → confirm → save. */

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
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { ROUTE_LABELS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createProjectUseCase, projectSlugTakenMessage } from '@src/business/project/create-project.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

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

/** Blank resolves to the name-derived default, which must be free too. */
const validateSlug =
  (name: string, taken: ReadonlySet<string>) =>
  (value: string): string | undefined => {
    const trimmed = value.trim();
    const effective = trimmed.length > 0 ? trimmed : toKebabCase(name);
    if (taken.has(effective)) return projectSlugTakenMessage(effective);
    if (trimmed.length === 0) return undefined;
    const parsed = Slug.parse(trimmed);
    if (parsed.ok) return undefined;
    const suggestion = toKebabCase(trimmed);
    return suggestion.length > 0 && suggestion !== trimmed
      ? `${parsed.error.message} — try ${suggestion}`
      : parsed.error.message;
  };

/** Slugs already in storage — the inline check; the use case re-checks at save. */
const useTakenSlugs = (projectRepo: AppDeps['projectRepo']): ReadonlySet<string> => {
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void projectRepo.list().then((r) => {
      if (!cancelled && r.ok) setTaken(new Set(r.value.map((p) => String(p.slug))));
    });
    return () => {
      cancelled = true;
    };
  }, [projectRepo]);
  return taken;
};

interface Update {
  readonly patch: Partial<Draft>;
  readonly next: StepKind;
}

type SaveOutcome =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly message: string; readonly returnTo: StepKind };

/** Parse the draft and save it through the create-project use case; failures name the step to fix. */
const saveDraft = async (draft: Draft, deps: Pick<AppDeps, 'projectRepo' | 'logger'>): Promise<SaveOutcome> => {
  const failAt = (message: string, returnTo: StepKind): SaveOutcome => ({ ok: false, message, returnTo });

  const pathResult = AbsolutePath.parse(expandHome(draft.repoPath.trim()));
  if (!pathResult.ok) return failAt(`repo path: ${pathResult.error.message}`, 'repo-path');

  const repoNameTrim = (draft.repoName ?? '').trim();
  const repoResult = createRepository({
    path: pathResult.value,
    ...(repoNameTrim.length > 0 ? { name: repoNameTrim } : {}),
  });
  if (!repoResult.ok) return failAt(`repo: ${repoResult.error.message}`, 'repo-name');

  const slugTrim = (draft.slug ?? '').trim();
  const slugInput = slugTrim.length > 0 ? Slug.parse(slugTrim) : undefined;
  if (slugInput !== undefined && !slugInput.ok) return failAt(`slug: ${slugInput.error.message}`, 'slug');

  const created = await createProjectUseCase({
    input: {
      displayName: draft.name.trim(),
      ...(slugInput !== undefined && slugInput.ok ? { slug: slugInput.value } : {}),
      ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : {}),
      repositories: [repoResult.value],
    },
    projectRepo: deps.projectRepo,
    logger: deps.logger,
  });
  if (created.ok) return { ok: true, project: created.value };
  if (created.error instanceof ConflictError) return failAt(created.error.message, 'slug');
  if (created.error instanceof ValidationError) return failAt(created.error.message, 'name');
  return failAt(created.error.message, 'confirm');
};

/** Where esc returns to — the entry below this view, or Work when it is the stack root. */
const parentLabel = (stack: readonly ViewEntry[]): string => {
  const parent = stack.length > 1 ? stack[stack.length - 2] : undefined;
  return parent !== undefined ? ROUTE_LABELS[parent.id] : 'Work';
};

export const CreateProjectView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const [step, setStep] = useState<Step>({ kind: 'name' });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const takenSlugs = useTakenSlugs(deps.projectRepo);

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
    const saved = await saveDraft(draft, deps);
    if (!saved.ok) return fail(saved.message, saved.returnTo);
    selection.setProject(saved.project.id, saved.project.displayName);
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
            takenSlugs={takenSlugs}
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
  readonly takenSlugs: ReadonlySet<string>;
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

const StepView = ({
  step,
  draft,
  onAdvance,
  onBack,
  onRetry,
  takenSlugs,
  onSubmit,
}: StepViewProps): React.JSX.Element => {
  const backLabel = parentLabel(useRouter().stack);
  // Per-step `key` gives each prompt a fresh buffer seeded from the draft.
  switch (step.kind) {
    case 'name':
      return (
        <TextPrompt
          key="name"
          message="Project display name"
          initial={draft.name}
          validate={validateName}
          escLabel={backLabel}
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
          validate={validateSlug(draft.name, takenSlugs)}
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
