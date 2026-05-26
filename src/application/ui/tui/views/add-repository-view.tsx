/**
 * Add-repository view — short wizard for attaching another repository to an existing project.
 * Walks: path → name → confirm. Persists via `addRepository(project, repo)` + `projectRepo.save`
 * so the aggregate's slug/id uniqueness invariants are enforced before disk write.
 *
 * Edit / remove live on the project-detail view; this is the dedicated `add` path so that the
 * wizard owns input focus for the duration of the prompts.
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
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { spacing, inkColors, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { addRepository } from '@src/domain/entity/project.ts';
import { createRepository } from '@src/domain/entity/repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

interface AddRepoProps extends Readonly<Record<string, unknown>> {
  readonly projectId: ProjectId;
}

type Step =
  | { readonly kind: 'path' }
  | { readonly kind: 'name'; readonly path: string }
  | { readonly kind: 'confirm'; readonly path: string; readonly name: string }
  | { readonly kind: 'saving' }
  | { readonly kind: 'error'; readonly message: string };

const expandHome = (input: string): string => {
  if (input === '~') return osHomedir();
  if (input.startsWith('~/')) return join(osHomedir(), input.slice(2));
  return input;
};

const backStep = (step: Step): Step | undefined => {
  switch (step.kind) {
    case 'path':
      return undefined;
    case 'name':
      return { kind: 'path' };
    case 'confirm':
      return { kind: 'name', path: step.path };
    case 'saving':
    case 'error':
      return undefined;
  }
};

export const AddRepositoryView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { projectId } = useViewProps<AddRepoProps>();
  const [step, setStep] = useState<Step>({ kind: 'path' });

  // Claim prompt focus only while a real prompt is rendered. In 'saving' / 'error' states no
  // component is listening for Esc, so we must release the claim so the parent router's global
  // Esc handler fires and the "Press esc to go back" hint becomes truthful.
  const claimPrompt = ui.claimPrompt;
  useEffect(() => {
    if (step.kind === 'path' || step.kind === 'name' || step.kind === 'confirm') {
      return claimPrompt();
    }
    return undefined;
  }, [claimPrompt, step.kind]);

  const cancel = (): void => router.pop();

  const submit = async (s: Extract<Step, { kind: 'confirm' }>): Promise<void> => {
    setStep({ kind: 'saving' });

    const expanded = expandHome(s.path.trim());
    const pathResult = AbsolutePath.parse(expanded);
    if (!pathResult.ok) {
      setStep({ kind: 'error', message: `path: ${pathResult.error.message}` });
      return;
    }

    const nameTrim = s.name.trim();
    const repoResult = createRepository({
      path: pathResult.value,
      ...(nameTrim.length > 0 ? { name: nameTrim } : {}),
    });
    if (!repoResult.ok) {
      setStep({ kind: 'error', message: repoResult.error.message });
      return;
    }

    const projectResult = await deps.projectRepo.findById(projectId);
    if (!projectResult.ok) {
      setStep({ kind: 'error', message: projectResult.error.message });
      return;
    }

    const updated = addRepository(projectResult.value, repoResult.value);
    if (!updated.ok) {
      setStep({ kind: 'error', message: updated.error.message });
      return;
    }

    const saved = await deps.projectRepo.save(updated.value);
    if (!saved.ok) {
      setStep({ kind: 'error', message: saved.error.message });
      return;
    }

    router.pop();
  };

  return (
    <ViewShell title="Add repository" subtitle="Attach another checkout to this project.">
      <Box flexDirection="column">
        <Card title="What we'll collect" tone="rule">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text dimColor>
              {glyphs.bullet} the absolute path of the repository (~/ allowed)
              {'\n'}
              {glyphs.bullet} a short display name (defaults to basename(path))
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
  // Per-step `key` so each prompt is a fresh instance — otherwise React's reconciliation
  // preserves the previous step's buffer at the same tree position. Esc on a non-first step
  // steps back instead of exiting the wizard.
  const prev = backStep(step);
  const cancelOrBack = prev !== undefined ? (): void => onChange(prev) : onCancel;
  switch (step.kind) {
    case 'path':
      return (
        <PathPickerPrompt
          key="path"
          message="Repository directory"
          onSubmit={(value) => onChange({ kind: 'name', path: value })}
          onCancel={cancelOrBack}
        />
      );
    case 'name': {
      const fallback = basename(expandHome(step.path));
      return (
        <TextPrompt
          key="name"
          message="Repository name (blank for default)"
          initial={fallback}
          onSubmit={(value) => onChange({ kind: 'confirm', path: step.path, name: value })}
          onCancel={cancelOrBack}
        />
      );
    }
    case 'confirm':
      return (
        <Box flexDirection="column">
          <FieldList
            fields={[
              { label: 'Path', value: <Text dimColor>{expandHome(step.path)}</Text> },
              {
                label: 'Name',
                value: step.name.trim().length > 0 ? step.name : basename(expandHome(step.path)),
              },
            ]}
          />
          <Box marginTop={spacing.section}>
            <ConfirmPrompt
              message="Add this repository?"
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
