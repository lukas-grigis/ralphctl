import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { formatIssueContext, type IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';

/**
 * Pre-fetch the issue context for a ticket whose `link` points to a GitHub or GitLab issue.
 * The fetched body is formatted as markdown and stashed on `ctx.currentIssueContext` for the
 * downstream `render-prompt-to-file` leaf to thread into the refine prompt.
 *
 * Soft-fail policy: any failure (no link, no fetcher injected, fetcher returns null, fetcher
 * errors) results in `Result.ok(undefined)` and a warn-level log. Refine without issue context
 * is still useful — we don't block the chain on a flaky network call to GitHub.
 */
export interface FetchIssueContextLeafDeps {
  readonly issueFetcher?: IssueFetcher;
  readonly eventBus: EventBus;
}

export const fetchIssueContextLeaf = (deps: FetchIssueContextLeafDeps, ticket: PendingTicket): Element<RefineCtx> =>
  leaf<RefineCtx, void, string | undefined>(`fetch-issue-context-${String(ticket.id)}`, {
    useCase: {
      execute: async () => {
        if (ticket.link === undefined) return Result.ok(undefined);
        if (deps.issueFetcher === undefined) {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `fetch-issue-context: no issueFetcher configured — proceeding without context`,
            meta: { ticketId: String(ticket.id), link: ticket.link },
            at: IsoTimestamp.now(),
          });
          return Result.ok(undefined);
        }
        const fetched = await deps.issueFetcher(ticket.link);
        if (!fetched.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `fetch-issue-context: fetch failed (${fetched.error.message}) — proceeding without context`,
            meta: { ticketId: String(ticket.id), link: ticket.link },
            at: IsoTimestamp.now(),
          });
          return Result.ok(undefined);
        }
        if (fetched.value === null) {
          deps.eventBus.publish({
            type: 'log',
            level: 'info',
            message: `fetch-issue-context: link not recognised or issue not found — proceeding without context`,
            meta: { ticketId: String(ticket.id), link: ticket.link },
            at: IsoTimestamp.now(),
          });
          return Result.ok(undefined);
        }
        return Result.ok(formatIssueContext(fetched.value));
      },
    },
    input: () => undefined,
    output: (ctx, issueContext) => ({
      ...ctx,
      currentTicket: ticket,
      ...(issueContext !== undefined ? { currentIssueContext: issueContext } : {}),
    }),
  });
