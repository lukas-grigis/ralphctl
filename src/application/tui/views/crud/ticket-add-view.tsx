/**
 * TicketAddView — add a ticket to the current sprint.
 *
 * Project scope is sprint-level — the ticket inherits the sprint's
 * `projectName` automatically. This view collects only ticket-specific
 * fields.
 *
 * Flow:
 *   1. Link / URL — entered FIRST. If it points at a GitHub or GitLab issue
 *      and `gh` / `glab` is in PATH, fetch the issue and use its title +
 *      body as the prefill defaults for the next two prompts. Empty link
 *      is allowed (manual entry).
 *   2. Title (input, defaulted to fetched issue title when present)
 *   3. Description (editor, defaulted to fetched issue body when present)
 *
 * After success, prompts "Add another ticket? [y/N]":
 *   y → re-runs the form from scratch.
 *   n / Enter → routes back to Home.
 *
 * Keyboard: Enter on error terminal state → pop view.
 */

import React, { useEffect, useState } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/application/tui/views/router-context.ts';
import { useWorkflow } from '@src/application/tui/components/use-workflow.ts';
import { promptOrPop } from '@src/application/tui/components/prompt-or-pop.ts';
import { resolveCurrentSprintId } from '@src/application/tui/components/resolve-current-sprint.ts';
import { getSharedDeps, getPrompt } from '@src/application/bootstrap/get-shared-deps.ts';
import { AddTicketUseCase } from '@src/business/usecases/ticket/add-ticket.ts';
import { PromptCancelledError } from '@src/business/ports/prompt-port.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

const HINTS = [{ key: 'Enter', action: 'confirm (terminal state)' }] as const;

export function TicketAddView(): React.JSX.Element {
  useViewHints(HINTS);
  const router = useRouter();
  const { phase, run, reset } = useWorkflow<Sprint>();
  // Incrementing runKey re-triggers the useEffect so the form re-runs.
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    run('Adding ticket…', async (setStep) => {
      const deps = await getSharedDeps();
      const idResult = await resolveCurrentSprintId(deps.configStore);
      if (!idResult.ok) throw new Error(idResult.error.message);

      const prompt = await getPrompt();

      // ── Link / URL first — prefill from gh/glab when possible ─────────
      setStep('Awaiting link…');
      const linkRaw = await promptOrPop(router, () =>
        prompt.input({ message: 'Link / issue URL (optional, leave blank to skip)', default: '' })
      );
      const link: string | undefined = linkRaw.trim() !== '' ? linkRaw.trim() : undefined;

      let prefilledTitle = '';
      let prefilledBody: string | undefined;
      if (link !== undefined) {
        setStep('Fetching issue from gh/glab…');
        const fetched = await deps.external.fetchIssue(link);
        if (fetched.ok && fetched.value !== null) {
          prefilledTitle = fetched.value.title;
          prefilledBody = fetched.value.body;
        }
        // fetch failure / 404 / non-issue URL: silently fall through to
        // manual entry — the link itself is still preserved on the ticket.
      }

      // ── Title — defaulted to fetched issue title when present ─────────
      let ticketTitle: string | undefined;
      let titleError: string | null = null;
      while (ticketTitle === undefined) {
        setStep(titleError !== null ? `${titleError} — try again…` : 'Awaiting ticket title…');
        const rawTitle = (
          await promptOrPop(router, () => prompt.input({ message: 'Title', default: prefilledTitle }))
        ).trim();
        if (rawTitle === '') {
          titleError = 'Title cannot be empty';
        } else {
          ticketTitle = rawTitle;
        }
      }
      const title: string = ticketTitle;

      // ── Description — defaulted to fetched issue body ─────────────────
      setStep('Awaiting description…');
      let description: string | undefined;
      try {
        const raw = await prompt.editor({
          message: 'Description',
          ...(prefilledBody !== undefined ? { default: prefilledBody } : {}),
        });
        description = raw?.trim() !== '' ? (raw?.trim() ?? undefined) : undefined;
      } catch (err) {
        if (err instanceof PromptCancelledError) description = undefined;
        else throw err;
      }

      setStep('Saving ticket…');
      const uc = new AddTicketUseCase(deps.sprintRepo);
      const result = await uc.execute({
        sprintId: idResult.value,
        ticketInput: {
          title,
          ...(description !== undefined ? { description } : {}),
          ...(link !== undefined ? { link } : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);

      // ── "Add another?" prompt — default No ───────────────────────────
      // The step label starts with "Awaiting" so the Spinner suppresses
      // itself while the confirm prompt is active.
      setStep('Awaiting add-another confirmation…');
      let addAnother = false;
      try {
        addAnother = await prompt.confirm({ message: 'Add another ticket?', default: false });
      } catch (err) {
        if (!(err instanceof PromptCancelledError)) throw err;
        // Cancel (Esc / Ctrl+C) on the confirm = same as "no"
      }

      // Attach the decision to the sprint value so the terminal handler can
      // act on it without cross-async-boundary state.
      // We use a symbol-keyed extension on the plain object to keep it opaque.
      return Object.assign(result.value, { __addAnother: addAnother });
    });
  }, [run, router, runKey]);

  useViewInput((_input, key) => {
    if (phase.kind !== 'done') return;
    if (phase.error !== null) {
      // Error state: Enter goes back.
      if (key.return) router.pop();
      return;
    }
    // Success state: Enter navigates home (the "add another" prompt is
    // handled inside the async flow, not here, so Enter on the result card
    // just exits).
    if (key.return) router.reset({ id: 'home' });
  });

  // After the async flow resolves, check if the user chose "add another".
  // If yes, reset workflow state and increment runKey to re-fire the effect.
  useEffect(() => {
    if (phase.kind !== 'done' || phase.error !== null) return;
    const addAnother = (phase.value as unknown as { __addAnother?: boolean }).__addAnother;
    if (addAnother === true) {
      reset();
      setRunKey((k) => k + 1);
    }
  }, [phase, reset]);

  return (
    <ViewShell title="ADD TICKET">
      {phase.kind === 'idle' || phase.kind === 'running' ? (
        <Spinner label={phase.kind === 'running' ? phase.label : 'Starting…'} />
      ) : phase.error !== null ? (
        <ResultCard
          kind="error"
          title="Failed to add ticket"
          lines={[phase.error]}
          {...(phase.hint !== undefined ? { hint: phase.hint } : {})}
          nextSteps={[{ action: 'Press Enter to go back' }]}
        />
      ) : (
        <ResultCard
          kind="success"
          title="Ticket added!"
          fields={[
            ['Sprint', String(phase.value.id)],
            ['Tickets', String(phase.value.tickets.length)],
          ]}
          nextSteps={[
            { action: 'Refine requirements', description: 'press r from Home' },
            { action: 'Press Enter to go to Home' },
          ]}
        />
      )}
    </ViewShell>
  );
}
