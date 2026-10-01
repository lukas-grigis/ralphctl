/**
 * Add-ticket view — interactive wizard that funnels through the `ticket-add` use case so the TUI and CLI share one
 * append path.
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
  | { readonly kind: 'create-failed'; readonly message: string; readonly hint: string };

/** Recovery copy for a tracker failure after the local save. */
const createFailedHint = (sprintId: SprintId, ticketId: string | undefined, orphaned: boolean): string => {
  if (orphaned) return 'The ticket was saved locally without the link — do not re-publish it.';
  const target = ticketId ?? '<ticket-id>';
  return `The ticket was saved locally — retry with: ralphctl ticket publish --sprint ${String(sprintId)} ${target}`;
};

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
    const ticketId = result.value.ctx.output?.id;
    return {
      kind: 'create-failed',
      message: trackerError.message,
      hint: createFailedHint(
        sprintId,
        ticketId !== undefined ? String(ticketId) : undefined,
        result.value.ctx.trackerIssueOrphaned === true
      ),
    };
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

  // Run the fetch once we transition into the 'fetching' step.
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
    if (outcome.kind === 'create-failed') {
      // The ticket itself was saved — only the tracker step failed — so it counts toward the
      // session total the next `link` step shows.
      setAddedCount((prev) => prev + 1);
      setStep(outcome);
      return;
    }
    if (outcome.kind === 'added') {
      // Stay in the flow: increment the session count and land on the `added` step, which offers "Add another
      // ticket?".
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
