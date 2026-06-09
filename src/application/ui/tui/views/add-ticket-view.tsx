/**
 * Add-ticket view — interactive wizard that funnels through the `ticket-add` use case so the
 * TUI and CLI share one append path. Walks: link → (fetch + prefill, when an `IssueFetcher`
 * is wired and the URL is non-empty) → title → description → confirm. Mirrors the chain-side
 * `interactive-add-loop` ordering so the URL becomes the source of truth: enter a GitHub /
 * GitLab issue URL and we pre-fill title + description from the issue body, so the user
 * doesn't copy-paste them by hand. Empty URL skips the fetch and falls back to manual entry.
 *
 * The sprint must be in `draft` (the use case enforces this) — non-draft sprints surface as
 * an error step.
 *
 * Step machine + per-step prompt views + the review scroll viewport all live under
 * `add-ticket-internals/`; this file owns the side-effects (fetcher dispatch, submit).
 */

import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { HeaderCard } from '@src/application/ui/tui/views/add-ticket-internals/header-card.tsx';
import { runFetch, StepView } from '@src/application/ui/tui/views/add-ticket-internals/step-view.tsx';
import type { Step } from '@src/application/ui/tui/views/add-ticket-internals/types.ts';

interface AddTicketProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

export const AddTicketView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { sprintId } = useViewProps<AddTicketProps>();
  const [step, setStep] = useState<Step>({ kind: 'link' });

  const claimPrompt = ui.claimPrompt;
  useEffect(() => claimPrompt(), [claimPrompt]);

  const cancel = (): void => router.pop();

  // Run the fetch once we transition into the 'fetching' step. Result advances to either
  // 'title' (with prefill from the issue) or 'fetch-failed' (user acks then falls back to
  // manual entry with the URL preserved). When no IssueFetcher is wired, the link step
  // routes straight to 'title' and this effect never fires.
  useEffect(() => {
    if (step.kind !== 'fetching') return;
    const fetcher = deps.issueFetcher;
    if (fetcher === undefined) {
      setStep({ kind: 'title', link: step.link, titleInitial: '', descriptionInitial: '' });
      return;
    }
    let cancelled = false;
    void runFetch(fetcher, step.link).then((next) => {
      if (cancelled) return;
      setStep(next);
    });
    return () => {
      cancelled = true;
    };
  }, [step, deps.issueFetcher]);

  const submit = async (s: Extract<Step, { kind: 'confirm' }>): Promise<void> => {
    setStep({ kind: 'saving' });
    const description = s.description.trim();
    const link = s.link.trim();
    const flow = createTicketAddFlow({ sprintRepo: deps.sprintRepo });
    const result = await flow.execute({
      input: {
        sprintId,
        title: s.title.trim(),
        ...(description.length > 0 ? { description } : {}),
        ...(link.length > 0 ? { link } : {}),
      },
    });
    if (!result.ok) {
      setStep({ kind: 'error', message: result.error.error.message });
      return;
    }
    router.pop();
  };

  return (
    <ViewShell title="Add ticket" subtitle="Append a pending ticket to the current sprint.">
      <Box flexDirection="column">
        <HeaderCard step={step} />
        <Box marginTop={spacing.section} flexDirection="column">
          <StepView step={step} onChange={setStep} onCancel={cancel} onSubmit={submit} />
        </Box>
      </Box>
    </ViewShell>
  );
};
