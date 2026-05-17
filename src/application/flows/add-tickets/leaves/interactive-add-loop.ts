import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { addTicketUseCase } from '@src/business/ticket/add-ticket.ts';
import type { IssueFetcher, ExternalIssue } from '@src/business/scm/issue-fetcher.ts';
import { checkAborted, type Element, type ElementResult } from '@src/application/chain/element.ts';
import { abortedEntry, type TraceEntry } from '@src/application/chain/trace.ts';
import type { AddTicketsCtx } from '@src/application/flows/add-tickets/ctx.ts';

export interface InteractiveAddLoopDeps {
  readonly interactive: InteractivePrompt;
  readonly logger: Logger;
  /**
   * Optional GitHub/GitLab fetcher. When supplied, each iteration opens with a URL prompt and
   * uses the fetched issue to pre-fill the edit form; when omitted (CI / no `gh`/`glab`), the
   * URL prompt is skipped and the loop runs as manual-entry only. A null fetch result (URL
   * unrecognised / 404) and a Result.error (network / spawn failure) both fall through to the
   * manual edit form with the URL preserved on `link`.
   */
  readonly issueFetcher?: IssueFetcher;
}

interface EditFormPrefill {
  readonly title: string;
  readonly description: string;
  readonly link: string;
}

const EMPTY_FORM: EditFormPrefill = { title: '', description: '', link: '' };

/**
 * Custom `Element` (not built via the standard `leaf` helper) so each loop iteration produces
 * its own `add-ticket-N` trace entry. The single-leaf shape would collapse the whole loop into
 * one entry — losing the granular progress signal the TUI relies on.
 *
 * Loop body per iteration:
 *  1. (When an `issueFetcher` is wired) Ask for the ticket URL — GitHub or GitLab. Empty input
 *     means "no URL, manual entry". A submitted URL is fetched; success pre-fills the form;
 *     failure (any reason) falls back to manual entry with the URL preserved on `link`.
 *  2. Show three editable fields (`title`, `description`, `link`) with the pre-filled values as
 *     their `initial`. Each `askText` lets the user accept or edit. An empty `title` after the
 *     edit step exits the loop.
 *  3. One `askConfirm({ message: 'Save this ticket?' })` covers all three fields. Reject loops
 *     back to step 1 (the URL prompt) without persisting; the user can try again.
 *  4. On confirm, call {@link addTicketUseCase}.
 *      - Success: append the ticket to `ctx.sprint`, push onto `ctx.addedTickets`, emit a
 *        `completed` trace entry, then ask `askConfirm({ message: 'add another?' })`.
 *      - Validation/conflict failure: surface the error message, record `failed`, retry the
 *        same iteration. Each prompt-cycle is its own trace entry so the trace stays linear.
 *
 * Cancel semantics — see `flow.ts`. A prompt-port failure (`askText` / `askConfirm` returns an
 * error such as `AbortError`) propagates as the leaf's failure; the surrounding chain skips
 * `save-sprint`, leaving any tickets added before the abort in memory only.
 */
export const interactiveAddLoopLeaf = (deps: InteractiveAddLoopDeps): Element<AddTicketsCtx> => ({
  name: 'interactive-add-loop',

  async execute(ctx, signal, onTrace): Promise<ElementResult<AddTicketsCtx>> {
    const aborted = checkAborted<AddTicketsCtx>('interactive-add-loop', signal, onTrace);
    if (aborted) return aborted;

    if (ctx.sprint === undefined) {
      const error = new InvalidStateError({
        entity: 'chain',
        currentState: 'pre-add-loop',
        attemptedAction: 'interactive-add-loop',
        message: 'interactive-add-loop: ctx.sprint is undefined — load-sprint must run first',
      });
      const entry: TraceEntry = { elementName: 'interactive-add-loop', status: 'failed', durationMs: 0, error };
      onTrace?.(entry);
      return Result.error({ error, trace: [entry] });
    }

    const log = deps.logger.named('add-tickets.loop');
    const trace: TraceEntry[] = [];
    let currentSprint: Sprint = ctx.sprint;
    const addedSoFar: PendingTicket[] = [...(ctx.addedTickets ?? [])];
    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        const entry = abortedEntry(`add-ticket-${String(attempt + 1)}`);
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: entry.error!, trace });
      }

      attempt += 1;
      const elementName = `add-ticket-${String(attempt)}`;
      const start = performance.now();

      // --- Phase 1: optional URL prefill --------------------------------------------------
      let prefill: EditFormPrefill = EMPTY_FORM;
      if (deps.issueFetcher !== undefined) {
        const urlAns = await deps.interactive.askText('Ticket URL (GitHub/GitLab issue, empty for manual):');
        if (!urlAns.ok) {
          const entry: TraceEntry = {
            elementName,
            status: 'failed',
            durationMs: performance.now() - start,
            error: urlAns.error,
          };
          trace.push(entry);
          onTrace?.(entry);
          return Result.error({ error: urlAns.error, trace });
        }
        const url = urlAns.value.trim();
        if (url.length === 0) {
          // No URL — see if the user wants to stop. First iteration: empty here is the
          // canonical "exit" signal (matches v1). Subsequent iterations: the post-save
          // "add another?" already handles exit; we treat empty URL here as "manual entry".
          if (addedSoFar.length === 0 && attempt === 1) break;
          // For subsequent iterations: still allow manual fallback.
        } else {
          const fetched = await fetchPrefill(deps.issueFetcher, url, log, deps.interactive);
          if (fetched === 'abort') {
            const entry: TraceEntry = {
              elementName,
              status: 'failed',
              durationMs: performance.now() - start,
              error: new InvalidStateError({
                entity: 'add-tickets',
                currentState: 'prefill',
                attemptedAction: 'fetch',
                message: 'prompt aborted while surfacing fetch failure',
              }),
            };
            trace.push(entry);
            onTrace?.(entry);
            return Result.error({ error: entry.error!, trace });
          }
          prefill = fetched;
        }
      }

      // --- Phase 2: editable form ----------------------------------------------------------
      const titleAns = await deps.interactive.askText('Title:', { initial: prefill.title });
      if (!titleAns.ok) {
        const entry: TraceEntry = {
          elementName,
          status: 'failed',
          durationMs: performance.now() - start,
          error: titleAns.error,
        };
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: titleAns.error, trace });
      }
      const title = titleAns.value.trim();
      if (title.length === 0) {
        // Empty title after the edit step is the user's exit signal once we're past the URL
        // prompt. The pre-incremented `attempt` is discarded; no trace entry is emitted.
        break;
      }

      const descAns = await deps.interactive.askText('Description (optional):', { initial: prefill.description });
      if (!descAns.ok) {
        const entry: TraceEntry = {
          elementName,
          status: 'failed',
          durationMs: performance.now() - start,
          error: descAns.error,
        };
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: descAns.error, trace });
      }
      const description = descAns.value.trim();

      const linkAns = await deps.interactive.askText('Link (optional):', { initial: prefill.link });
      if (!linkAns.ok) {
        const entry: TraceEntry = {
          elementName,
          status: 'failed',
          durationMs: performance.now() - start,
          error: linkAns.error,
        };
        trace.push(entry);
        onTrace?.(entry);
        return Result.error({ error: linkAns.error, trace });
      }
      const link = linkAns.value.trim();

      // --- Phase 3: confirm --------------------------------------------------------------
      const summary = [
        `Title:       ${title}`,
        description.length > 0 ? `Description: ${description}` : 'Description: (none)',
        link.length > 0 ? `Link:        ${link}` : 'Link:        (none)',
        '',
        'Save this ticket?',
      ].join('\n');
      const confirm = await deps.interactive.askConfirm({ message: summary });
      if (!confirm.ok) {
        return Result.error({ error: confirm.error, trace });
      }
      if (!confirm.value) {
        // Discard this iteration without persisting; loop back to the URL prompt. Don't
        // increment the trace — the user explicitly rejected.
        attempt -= 1;
        continue;
      }

      const ticketInput = {
        title,
        ...(description.length > 0 ? { description } : {}),
        ...(link.length > 0 ? { link } : {}),
      };
      const useCaseResult = addTicketUseCase({ sprint: currentSprint, ticket: ticketInput, logger: deps.logger });
      const durationMs = performance.now() - start;

      if (!useCaseResult.ok) {
        const error: DomainError = useCaseResult.error;
        const entry: TraceEntry = { elementName, status: 'failed', durationMs, error };
        trace.push(entry);
        onTrace?.(entry);
        const surface = await deps.interactive.askText(`Could not add ticket: ${error.message}. Press Enter to retry.`);
        if (!surface.ok) {
          return Result.error({ error: surface.error, trace });
        }
        continue;
      }

      currentSprint = useCaseResult.value.sprint;
      addedSoFar.push(useCaseResult.value.ticket);
      const entry: TraceEntry = { elementName, status: 'completed', durationMs };
      trace.push(entry);
      onTrace?.(entry);

      const more = await deps.interactive.askConfirm({ message: 'Add another ticket?' });
      if (!more.ok) {
        return Result.error({ error: more.error, trace });
      }
      if (!more.value) break;
    }

    const nextCtx: AddTicketsCtx = { ...ctx, sprint: currentSprint, addedTickets: addedSoFar };
    return Result.ok({ ctx: nextCtx, trace });
  },
});

/**
 * Fetch the issue at `url` and translate it into edit-form prefill. The contract:
 *  - Success → prefill with title / body / url.
 *  - Ok-null (URL unrecognised or 404) → prefill with empty title/body but URL kept on link;
 *    a one-line warning is surfaced via `askText` so the user knows manual entry is next.
 *  - Result.error (CLI not installed, timeout, auth) → same fallback as ok-null; the error
 *    message goes into the warning line.
 *  - Returns the literal string `'abort'` only when the warning prompt itself fails (user
 *    cancelled mid-warning). Callers translate this into a trace failure.
 */
const fetchPrefill = async (
  fetcher: IssueFetcher,
  url: string,
  log: Logger,
  interactive: InteractivePrompt
): Promise<EditFormPrefill | 'abort'> => {
  const result = await fetcher(url);
  if (result.ok && result.value !== null) {
    return toPrefill(result.value, url);
  }
  const reason = !result.ok
    ? result.error.message
    : 'URL not recognised or issue not accessible — fall back to manual entry.';
  log.warn(`fetch failed for ${url}: ${reason}`);
  const ack = await interactive.askText(`✗ fetch failed: ${reason}. Press Enter to enter manually.`);
  if (!ack.ok) return 'abort';
  return { ...EMPTY_FORM, link: url };
};

const toPrefill = (issue: ExternalIssue, fallbackUrl: string): EditFormPrefill => ({
  title: issue.title,
  description: issue.body,
  link: issue.url.length > 0 ? issue.url : fallbackUrl,
});
