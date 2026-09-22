/**
 * Add-ticket view — interactive wizard that funnels through the `ticket-add` use case so the
 * TUI and CLI share one append path. Walks: link → (fetch + prefill, when an `IssueFetcher`
 * is wired and the URL is non-empty) → title → description → confirm → optional create-issue
 * prompt (default No) when the ticket has no link and the first repository origin resolves.
 * Mirrors the chain-side ordering so the URL becomes the source of truth: enter a GitHub /
 * GitLab issue URL and we pre-fill title + description from the issue body, so the user
 * doesn't copy-paste them by hand. Empty URL skips the fetch and falls back to manual entry.
 *
 * This is the ONE canonical "add tickets to a sprint" path (the redundant `add-tickets` chain
 * flow was removed). To keep the user in the flow of adding things, a successful save no longer
 * pops the view immediately: it lands on an `added` step that shows a brief acknowledgement plus
 * a running session count and an "Add another ticket?" confirm. Answering YES resets the machine
 * to a fresh `link` step (preserving the incremented count); answering NO pops the view.
 *
 * The sprint must be in `draft` (the use case enforces this) — non-draft sprints surface as
 * an error step.
 *
 * Step machine + per-step prompt views + the review scroll viewport all live under
 * `add-ticket-internals/`; this file owns the side-effects (fetcher dispatch, submit, count).
 */

import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { HeaderCard } from '@src/application/ui/tui/views/add-ticket-internals/header-card.tsx';
import { runFetch, StepView } from '@src/application/ui/tui/views/add-ticket-internals/step-view.tsx';
import type { Step, TicketDraft } from '@src/application/ui/tui/views/add-ticket-internals/types.ts';

interface AddTicketProps extends Readonly<Record<string, unknown>> {
  readonly sprintId: SprintId;
}

const originResolves = async (deps: AppDeps, sprintId: SprintId): Promise<boolean> => {
  const pusher = deps.issuePusher;
  if (pusher === undefined) return false;
  const sprint = await deps.sprintRepo.findById(sprintId);
  if (!sprint.ok) return false;
  const project = await deps.projectRepo?.findById(sprint.value.projectId);
  if (project === undefined || !project.ok) return false;
  const cwd = project.value.repositories[0]?.path;
  if (cwd === undefined) return false;
  const origin = await pusher.resolveOrigin(cwd);
  return origin.ok && origin.value !== null;
};

type PersistOutcome =
  | { readonly kind: 'added' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'create-failed'; readonly message: string };

const persistTicket = async (deps: AppDeps, sprintId: SprintId, draft: TicketDraft): Promise<PersistOutcome> => {
  const description = draft.description.trim();
  const link = draft.link.trim();
  const flow = createTicketAddFlow({
    sprintRepo: deps.sprintRepo,
    ...(deps.projectRepo !== undefined ? { projectRepo: deps.projectRepo } : {}),
    ...(deps.issuePusher !== undefined ? { issuePusher: deps.issuePusher } : {}),
  });
  const result = await flow.execute({
    input: {
      sprintId,
      title: draft.title.trim(),
      ...(description.length > 0 ? { description } : {}),
      ...(link.length > 0 ? { link } : {}),
      ...(draft.createTrackerIssue === true ? { createTrackerIssue: true } : {}),
    },
  });
  if (!result.ok) {
    return { kind: 'error', message: result.error.error.message };
  }
  const trackerError = result.value.ctx.trackerError;
  if (trackerError !== undefined) {
    return { kind: 'create-failed', message: trackerError.message };
  }
  return { kind: 'added' };
};

export const AddTicketView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const { sprintId } = useViewProps<AddTicketProps>();
  const [step, setStep] = useState<Step>({ kind: 'link' });
  // Tickets successfully appended during this view session. Drives the success-line counter and
  // survives the `added` → fresh-`link` loop so each round shows the running total.
  const [addedCount, setAddedCount] = useState(0);

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

  const persist = async (draft: TicketDraft): Promise<void> => {
    setStep({ kind: 'saving' });
    const outcome = await persistTicket(deps, sprintId, draft);
    if (outcome.kind === 'added') {
      // Stay in the flow: increment the session count and land on the `added` step, which offers
      // "Add another ticket?". YES resets the machine to a fresh `link` (handled in StepView); NO
      // pops the view. The count is read back via the functional updater so concurrent saves can't
      // race a stale closure value.
      setAddedCount((prev) => {
        const count = prev + 1;
        setStep({ kind: 'added', title: draft.title.trim(), count });
        return count;
      });
      return;
    }
    setStep(outcome);
  };

  const submit = async (draft: TicketDraft): Promise<void> => {
    const shouldAsk =
      draft.createTrackerIssue === undefined &&
      draft.link.trim().length === 0 &&
      (await originResolves(deps, sprintId));
    if (shouldAsk) {
      setStep({
        kind: 'ask-create',
        link: draft.link,
        title: draft.title,
        description: draft.description,
      });
      return;
    }
    await persist(draft);
  };

  return (
    <ViewShell title="Add ticket" subtitle="Append a pending ticket to the current sprint.">
      <Box flexDirection="column">
        <HeaderCard step={step} addedCount={addedCount} />
        <Box marginTop={spacing.section} flexDirection="column">
          <StepView step={step} onChange={setStep} onCancel={cancel} onSubmit={submit} />
        </Box>
      </Box>
    </ViewShell>
  );
};
