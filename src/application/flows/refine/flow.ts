import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { type PendingTicket, type Ticket } from '@src/domain/entity/ticket.ts';
import { type AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import { type Element, withDisplay } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import type { RefineDeps } from '@src/application/flows/refine/deps.ts';
import { fetchIssueContextLeaf } from '@src/application/flows/refine/leaves/fetch-issue-context.ts';
import { refineTicketInteractiveLeaf } from '@src/application/flows/refine/leaves/refine-ticket-interactive.ts';
import { saveRefinedTicketLeaf } from '@src/application/flows/refine/leaves/save-refined-ticket.ts';
import { buildRefinePrompt } from '@src/integration/ai/prompts/refine/definition.ts';
import { readCappedSprintProgress } from '@src/application/flows/_shared/progress/read-sprint-progress.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';
import { aiUnitEpilogue, aiUnitPrelude } from '@src/application/flows/_shared/ai-unit-segment.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';

export interface CreateRefineFlowOpts {
  readonly sprintId: SprintId;
  /**
   * Pending tickets to refine, in processing order. Caller has already filtered the sprint's
   * tickets to `status === 'pending'`. The chain unrolls per-ticket sub-chains at construction
   * time so the trace names every ticket — a crash mid-run shows exactly which ticket failed.
   */
  readonly pendingTickets: readonly PendingTicket[];
  /** Provider id used to attribute every per-ticket spawn in its `meta.json` sidecar. */
  readonly providerId: string;
  /** Configured model for the refine chain. */
  readonly model: string;
  /** Resolved effort / reasoning level for the refine chain — optional. */
  readonly effort?: string;
  /** Per-sprint refinement directory: `<sprintDir>/refinement/`. The chain materialises per-ticket subfolders under it. */
  readonly refinementRoot: AbsolutePath;
}

/**
 * Refine each pending ticket of a draft sprint in its own interactive AI session; the AI writes
 * `<unit-root>/requirements.md`, which the harness reads back and saves per ticket.
 */
export const createRefineFlow = (deps: RefineDeps, opts: CreateRefineFlowOpts): Element<RefineCtx> => {
  const ticketSlug = (ticket: Ticket): string => {
    const fromTitle = toKebabCase(ticket.title);
    if (fromTitle.length > 0) {
      const validated = Slug.parse(fromTitle.slice(0, 60));
      if (validated.ok) return String(validated.value);
    }
    return `t-${String(ticket.id).slice(0, 8)}`;
  };

  const perTicketChains: ReadonlyArray<Element<RefineCtx>> = opts.pendingTickets.map((ticket) => {
    const ticketId = String(ticket.id);
    const unitOpts = {
      unitName: 'refine',
      flowId: 'refine' as const,
      nameSuffix: `-${ticketId}`,
      parent: () => opts.refinementRoot,
      slug: () => ticketSlug(ticket),
      buildPrompt: async (ctx: RefineCtx) => {
        const currentUnitRoot = assertCtxField(
          ctx,
          'currentUnitRoot',
          `render-prompt-to-file-${ticketId}`,
          'pre-render-prompt'
        );
        const priorProgress = await readCappedSprintProgress(opts.refinementRoot, opts.model);
        return buildRefinePrompt(deps.templateLoader, {
          ticket,
          outputContractSection: renderContractSectionFor(refineOutputContract, currentUnitRoot),
          priorProgress,
          ...(ctx.currentIssueContext !== undefined ? { issueContext: ctx.currentIssueContext } : {}),
        });
      },
      providerId: opts.providerId,
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ticketId,
    } satisfies Parameters<typeof aiUnitPrelude<RefineCtx>>[1];

    const unit = sequential<RefineCtx>(`refine-${ticketId}`, [
      fetchIssueContextLeaf(
        { eventBus: deps.eventBus, ...(deps.issueFetcher !== undefined ? { issueFetcher: deps.issueFetcher } : {}) },
        ticket
      ),
      ...aiUnitPrelude<RefineCtx>(
        {
          writeFile: deps.writeFile,
          skillsAdapter: deps.skillsAdapter,
          skillSource: deps.skillSource,
          clock: deps.clock,
        },
        unitOpts
      ),
      refineTicketInteractiveLeaf(
        {
          interactiveAi: deps.interactiveAi,
          runInTerminal: deps.runInTerminal,
          logger: deps.logger,
          writeFile: deps.writeFile,
          publishSignal: createPublishSignal(deps.eventBus, 'refine'),
          eventBus: deps.eventBus,
          model: opts.model,
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
          ...(deps.issuePusher !== undefined ? { issuePusher: deps.issuePusher } : {}),
        },
        ticket
      ),
      ...aiUnitEpilogue<RefineCtx>({ skillsAdapter: deps.skillsAdapter }, unitOpts),
      withDisplay(saveRefinedTicketLeaf({ sprintRepo: deps.sprintRepo }, ticket), { label: 'Save ticket' }),
    ]);
    return withDisplay(unit, { label: ticket.title, workItem: { kind: 'ticket', id: ticketId } });
  });

  return sequential<RefineCtx>('refine', [
    loadAndAssertSprintSubChain<RefineCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    sequential<RefineCtx>('refine-tickets', perTicketChains, { label: 'Refine tickets' }),
  ]);
};
