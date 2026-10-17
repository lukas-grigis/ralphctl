/**
 * Create-project view — interactive wizard for assembling a new {@link Project} aggregate.
 *
 * Walks the user through:
 *   1. Project display name (required)
 *   2. Project slug (defaults to kebab-case(name); editable)
 *   3. Project description (optional, blank to skip)
 *   4. First repository path (required, absolute; `~/` is expanded against `os.homedir()`)
 *   5. First repository name (defaults to basename(path))
 *   6. Confirm → save via `createProjectUseCase` (rejects a taken slug), stamp the new id as current, then route home.
 *      On a failure, esc returns to the step the error points at (confirm for storage), answers kept.
 *
 * Mirrors the welcome-view embedding style: prompts are rendered inline rather than going
 * through the prompt queue, since this view *is* a sequence of prompts and has nothing else
 * competing for keyboard focus.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { usePromptInput } from '@src/application/ui/tui/prompts/use-prompt-input.ts';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { PathPickerPrompt } from '@src/application/ui/tui/prompts/path-picker-prompt.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { expandHome } from '@src/application/ui/tui/runtime/expand-home.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createProjectUseCase } from '@src/business/project/create-project.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';

/** Every answer the wizard collects — the confirm step's payload. */
interface Draft {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly repoPath: string;
  readonly repoName: string;
}

/** `prefill` holds answers from a later step the user stepped back from, used as prompt defaults. */
interface Prefill {
  readonly prefill?: Draft;
}

type Step =
  | { readonly kind: 'name' }
  | ({ readonly kind: 'slug'; readonly name: string } & Prefill)
  | ({ readonly kind: 'description'; readonly name: string; readonly slug: string } & Prefill)
  | ({
      readonly kind: 'repo-path';
      readonly name: string;
      readonly slug: string;
      readonly description: string;
    } & Prefill)
  | ({
      readonly kind: 'repo-name';
      readonly name: string;
      readonly slug: string;
      readonly description: string;
      readonly repoPath: string;
    } & Prefill)
  | ({ readonly kind: 'confirm' } & Draft)
  | { readonly kind: 'saving' }
  | { readonly kind: 'error'; readonly message: string; readonly back: Step };

type ConfirmStep = Extract<Step, { kind: 'confirm' }>;

const carry = (prefill: Draft | undefined): Prefill => (prefill !== undefined ? { prefill } : {});

const draftOf = (s: ConfirmStep): Draft => ({
  name: s.name,
  slug: s.slug,
  description: s.description,
  repoPath: s.repoPath,
  repoName: s.repoName,
});

/**
 * Previous step for the current one. Used as the `esc` target so the user can fix a typo
 * without starting the wizard over. Returns `undefined` on the first step (esc cancels the
 * wizard entirely) and while saving.
 */
const backStep = (step: Step): Step | undefined => {
  switch (step.kind) {
    case 'name':
      return undefined;
    case 'slug':
      // A new name re-derives the slug default, so kept answers stop here.
      return { kind: 'name' };
    case 'description':
      return { kind: 'slug', name: step.name, ...carry(step.prefill) };
    case 'repo-path':
      return { kind: 'description', name: step.name, slug: step.slug, ...carry(step.prefill) };
    case 'repo-name':
      return {
        kind: 'repo-path',
        name: step.name,
        slug: step.slug,
        description: step.description,
        ...carry(step.prefill),
      };
    case 'confirm':
      return {
        kind: 'repo-name',
        name: step.name,
        slug: step.slug,
        description: step.description,
        repoPath: step.repoPath,
        prefill: draftOf(step),
      };
    case 'saving':
      return undefined;
    case 'error':
      return step.back;
  }
};

type ErrorStep = Extract<Step, { kind: 'error' }>;

/** Validates the confirmed answers and persists them; a failure names the step esc returns to. */
const saveProject = async (
  deps: Pick<AppDeps, 'projectRepo' | 'logger'>,
  s: ConfirmStep
): Promise<{ readonly kind: 'saved'; readonly project: Project } | ErrorStep> => {
  const prefill = draftOf(s);
  const atSlug: Step = { kind: 'slug', name: s.name, prefill };

  const pathResult = AbsolutePath.parse(expandHome(s.repoPath.trim()));
  if (!pathResult.ok) {
    return {
      kind: 'error',
      message: `repo path: ${pathResult.error.message}`,
      back: { kind: 'repo-path', name: s.name, slug: s.slug, description: s.description, prefill },
    };
  }

  const repoNameTrim = s.repoName.trim();
  const repoResult = createRepository({
    path: pathResult.value,
    ...(repoNameTrim.length > 0 ? { name: repoNameTrim } : {}),
  });
  if (!repoResult.ok) {
    return {
      kind: 'error',
      message: `repo: ${repoResult.error.message}`,
      back: {
        kind: 'repo-name',
        name: s.name,
        slug: s.slug,
        description: s.description,
        repoPath: s.repoPath,
        prefill,
      },
    };
  }

  const slugInput = s.slug.trim().length > 0 ? Slug.parse(s.slug.trim()) : undefined;
  if (slugInput !== undefined && !slugInput.ok) {
    return { kind: 'error', message: `slug: ${slugInput.error.message}`, back: atSlug };
  }

  const projectResult = await createProjectUseCase({
    input: {
      displayName: s.name.trim(),
      ...(slugInput !== undefined && slugInput.ok ? { slug: slugInput.value } : {}),
      ...(s.description.trim().length > 0 ? { description: s.description.trim() } : {}),
      repositories: [repoResult.value],
    },
    projectRepo: deps.projectRepo,
    logger: deps.logger,
  });
  if (!projectResult.ok) {
    const error = projectResult.error;
    const slugTaken = error instanceof ConflictError && error.field === 'slug';
    // A failure tied to no single answer (storage) returns to confirm, so a retry is one key.
    return { kind: 'error', message: error.message, back: slugTaken ? atSlug : s };
  }
  return { kind: 'saved', project: projectResult.value };
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

  const submit = async (s: ConfirmStep): Promise<void> => {
    setStep({ kind: 'saving' });
    const outcome = await saveProject(deps, s);
    if (outcome.kind === 'error') {
      setStep(outcome);
      return;
    }
    selection.setProject(outcome.project.id, outcome.project.displayName);
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
  readonly onSubmit: (s: ConfirmStep) => Promise<void>;
}

const renderNameStep = (onChange: StepViewProps['onChange'], cancelOrBack: () => void): React.JSX.Element => (
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

const renderSlugStep = (
  step: Extract<Step, { kind: 'slug' }>,
  onChange: StepViewProps['onChange'],
  cancelOrBack: () => void
): React.JSX.Element => (
  <TextPrompt
    key="slug"
    message="Project slug (kebab-case, blank for default)"
    initial={(step.prefill?.slug.trim() ?? '') || toKebabCase(step.name)}
    onSubmit={(value) => onChange({ kind: 'description', name: step.name, slug: value, ...carry(step.prefill) })}
    onCancel={cancelOrBack}
  />
);

const renderDescriptionStep = (
  step: Extract<Step, { kind: 'description' }>,
  onChange: StepViewProps['onChange'],
  cancelOrBack: () => void
): React.JSX.Element => (
  <TextPrompt
    key="description"
    message="Description (optional, Enter to skip)"
    initial={step.prefill?.description ?? ''}
    onSubmit={(value) =>
      onChange({ kind: 'repo-path', name: step.name, slug: step.slug, description: value, ...carry(step.prefill) })
    }
    onCancel={cancelOrBack}
  />
);

const renderRepoPathStep = (
  step: Extract<Step, { kind: 'repo-path' }>,
  onChange: StepViewProps['onChange'],
  cancelOrBack: () => void
): React.JSX.Element => (
  <PathPickerPrompt
    key="repo-path"
    message="Repository directory"
    {...(step.prefill !== undefined ? { initial: step.prefill.repoPath } : {})}
    onSubmit={(value) =>
      onChange({
        kind: 'repo-name',
        name: step.name,
        slug: step.slug,
        description: step.description,
        repoPath: value,
        ...carry(step.prefill),
      })
    }
    onCancel={cancelOrBack}
  />
);

const renderRepoNameStep = (
  step: Extract<Step, { kind: 'repo-name' }>,
  onChange: StepViewProps['onChange'],
  cancelOrBack: () => void
): React.JSX.Element => {
  // A kept repo name only applies to the directory it was typed for.
  const kept = step.prefill?.repoPath === step.repoPath ? step.prefill.repoName.trim() : '';
  const fallback = kept || basename(expandHome(step.repoPath));
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
};

const renderConfirmStep = (
  step: ConfirmStep,
  onSubmit: StepViewProps['onSubmit'],
  cancelOrBack: () => void
): React.JSX.Element => (
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

interface ErrorNoticeProps {
  readonly message: string;
  readonly onBack: () => void;
}

// The view's prompt claim mutes the global esc, so the error step answers it itself.
const ErrorNotice = ({ message, onBack }: ErrorNoticeProps): React.JSX.Element => {
  usePromptInput((_input, key) => {
    if (key.escape) onBack();
  });
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.error}>
        {glyphs.cross} {message}
      </Text>
      <Text dimColor>Press esc to go back.</Text>
    </Box>
  );
};

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
      return renderNameStep(onChange, cancelOrBack);
    case 'slug':
      return renderSlugStep(step, onChange, cancelOrBack);
    case 'description':
      return renderDescriptionStep(step, onChange, cancelOrBack);
    case 'repo-path':
      return renderRepoPathStep(step, onChange, cancelOrBack);
    case 'repo-name':
      return renderRepoNameStep(step, onChange, cancelOrBack);
    case 'confirm':
      return renderConfirmStep(step, onSubmit, cancelOrBack);
    case 'saving':
      return <Spinner label="saving project…" />;
    case 'error':
      return <ErrorNotice message={step.message} onBack={cancelOrBack} />;
  }
};
