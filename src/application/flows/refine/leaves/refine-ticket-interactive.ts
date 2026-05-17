import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { refineTicketUseCase } from '@src/business/ticket/refine-ticket.ts';
import { replaceTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import { setTicketLink, type ApprovedTicket, type PendingTicket, type Ticket } from '@src/domain/entity/ticket.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';

/**
 * Chain leaf — drives the user-in-the-loop AI session for one ticket. Integration work
 * (terminal hand-off, read the AI's output file, accept either JSON or markdown shape) lives
 * here; the business decision to approve the ticket and replace it on the sprint lives in
 * {@link refineTicketUseCase}.
 *
 * Failure modes (each leaves the sprint untouched):
 *   - AI exits non-zero (user cancelled, internal error) → bubbles its error.
 *   - Output file missing after AI exit → `InvalidStateError`.
 *   - Output file empty / fails domain validation → forwarded from the use case.
 */
export type RunInTerminal = <T>(fn: () => Promise<T>) => Promise<T>;

export interface RefineTicketInteractiveDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  readonly cwd: AbsolutePath;
  readonly model: string;
  /**
   * Optional human-in-the-loop approval callback wired by the flow factory. The launcher
   * threads in a TUI prompt that shows the proposed requirements and asks accept/reject.
   * When omitted (tests, headless) the use case auto-accepts the AI's body.
   */
  readonly reviewBeforeApprove?: (
    proposed: string,
    ticket: PendingTicket
  ) => Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean }>;
  /**
   * Optional pusher — supplied alongside `defaultIssueOrigin` from the launcher. When the
   * reviewer picks "Approve & update origin", the leaf calls update / create here. Any failure
   * is swallowed (logged + surfaced via the chain trace as a `note` would be, but the leaf
   * still completes successfully — local refinement always lands).
   */
  readonly issuePusher?: IssuePusher;
  /**
   * Project-level default for "create a new issue" when the approved ticket has no `link`.
   * When neither this nor `ticket.link` is set, the launcher's 3-way prompt hides the middle
   * option and the leaf never sees `alsoUpdateOrigin: true`.
   */
  readonly defaultIssueOrigin?: IssueOriginRef;
}

/** Footer appended to every pushed body so future readers know where it came from. */
const REFINED_FOOTER = (now: string): string => `\n\n---\n_Refined by ralphctl on ${now}_`;

interface RefineTicketInteractiveInput {
  readonly sprint: Sprint;
  readonly ticket: PendingTicket;
  readonly promptFile: AbsolutePath;
  readonly outputFile: AbsolutePath;
}

interface RefineTicketInteractiveOutput {
  readonly sprint: Sprint;
  readonly ticket: Ticket;
  /** `false` when the reviewer rejected the AI's proposal; the chain leaves the sprint untouched. */
  readonly accepted: boolean;
}

/**
 * Best-effort push to the issue tracker. On success, returns a (possibly updated) ticket —
 * after a CREATE we attach the new URL to ticket.link. On failure, logs a warning and returns
 * the input ticket unchanged. Never throws; never aborts the chain.
 */
const maybePushOrigin = async (
  deps: RefineTicketInteractiveDeps,
  ticket: ApprovedTicket,
  body: string
): Promise<ApprovedTicket> => {
  if (deps.issuePusher === undefined) {
    deps.logger.named('refine.push').warn('no IssuePusher wired — skipping origin update');
    return ticket;
  }
  const now = new Date().toISOString().slice(0, 10);
  const fullBody = `${body}${REFINED_FOOTER(now)}`;

  if (ticket.link !== undefined) {
    const url = String(ticket.link);
    const result = await deps.issuePusher.update(url, { body: fullBody });
    if (!result.ok) {
      deps.logger.named('refine.push').warn(`origin update failed (${url}): ${result.error.message}`);
    } else {
      deps.logger.named('refine.push').info(`updated origin issue ${url}`);
    }
    return ticket;
  }

  if (deps.defaultIssueOrigin !== undefined) {
    const created = await deps.issuePusher.create(deps.defaultIssueOrigin, { title: ticket.title, body: fullBody });
    if (!created.ok) {
      deps.logger.named('refine.push').warn(`origin create failed: ${created.error.message}`);
      return ticket;
    }
    const withLink = setTicketLink(ticket, created.value.url);
    if (!withLink.ok) {
      deps.logger.named('refine.push').warn(`origin create succeeded but link was invalid: ${withLink.error.message}`);
      return ticket;
    }
    deps.logger.named('refine.push').info(`created origin issue ${created.value.url}`);
    return withLink.value;
  }

  // alsoUpdateOrigin was set but no target exists. Shouldn't happen — the launcher hides the
  // option in this case — but degrade gracefully if it slips through.
  deps.logger.named('refine.push').warn('alsoUpdateOrigin requested but no link / defaultIssueOrigin available');
  return ticket;
};

export const refineTicketInteractiveLeaf = (
  deps: RefineTicketInteractiveDeps,
  ticket: PendingTicket
): Element<RefineCtx> =>
  leaf<RefineCtx, RefineTicketInteractiveInput, RefineTicketInteractiveOutput>(`refine-ticket-${String(ticket.id)}`, {
    useCase: {
      execute: async (input) => {
        const session = await deps.runInTerminal(async () =>
          deps.interactiveAi.run({
            cwd: deps.cwd,
            promptFile: input.promptFile,
            outputFile: input.outputFile,
            model: deps.model,
          })
        );
        if (!session.ok) return Result.error(session.error);

        let raw: string;
        try {
          raw = await fs.readFile(String(input.outputFile), 'utf8');
        } catch (cause) {
          const causeMsg = cause instanceof Error ? cause.message : String(cause);
          return Result.error(
            new InvalidStateError({
              entity: 'refine-ticket-interactive',
              currentState: 'post-session',
              attemptedAction: 'read-output',
              message: `refine: AI exited but output file is missing: ${String(input.outputFile)} (${causeMsg})`,
            })
          );
        }
        const body = extractRequirementsBody(raw);
        const useCaseResult = await refineTicketUseCase({
          sprint: input.sprint,
          ticket: input.ticket,
          requirementsBody: body,
          logger: deps.logger,
          ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
        });
        if (!useCaseResult.ok) return Result.error(useCaseResult.error);
        const out = useCaseResult.value;
        if (!out.accepted || !out.alsoUpdateOrigin) return Result.ok(out);
        // Approve + push path. The approve already swapped the ticket on the sprint; if the
        // push CREATEs an issue, we need to also write the returned URL back onto the ticket
        // AND replace it on the sprint again (so subsequent loads see the link).
        const approvedTicket = out.ticket as ApprovedTicket;
        const finalTicket = await maybePushOrigin(deps, approvedTicket, body);
        if (finalTicket === approvedTicket) return Result.ok(out);
        const replaced = replaceTicket(out.sprint, finalTicket.id, finalTicket);
        if (!replaced.ok) return Result.error(replaced.error);
        return Result.ok({ ...out, sprint: replaced.value, ticket: finalTicket });
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-refine',
          attemptedAction: `refine-ticket-${String(ticket.id)}`,
          message: `refine-ticket-${String(ticket.id)}: ctx.sprint is undefined — load-sprint must run first`,
        });
      }
      if (ctx.currentPromptFile === undefined || ctx.currentOutputFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-refine',
          attemptedAction: `refine-ticket-${String(ticket.id)}`,
          message: `refine-ticket-${String(ticket.id)}: prompt/output paths missing — render-prompt-to-file must run first`,
        });
      }
      return {
        sprint: ctx.sprint,
        ticket,
        promptFile: ctx.currentPromptFile,
        outputFile: ctx.currentOutputFile,
      };
    },
    output: (ctx, out) => {
      // On reject, leave ctx unchanged — sprint is the same instance the leaf received and
      // the proposed ticket should not appear in `refinedTickets` (the trace still records
      // that we ran, but downstream `save-after-<id>` writes a no-op).
      if (!out.accepted) return { ...ctx, sprint: out.sprint };
      return {
        ...ctx,
        sprint: out.sprint,
        refinedTickets: [...(ctx.refinedTickets ?? []), out.ticket as ApprovedTicket],
      };
    },
  });

/**
 * Accept either v1's JSON shape `[{ "ref": "...", "requirements": "..." }]` or plain markdown.
 * v1 used JSON to support multi-ticket batches; v2's interactive refine is one-ticket-per-call,
 * so the AI is told to write markdown directly. The JSON path is here for backward-compat with
 * users who configured v1's prompt template style.
 */
const extractRequirementsBody = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { requirements?: string };
      if (typeof first.requirements === 'string') return first.requirements;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as { requirements?: string };
      if (typeof obj.requirements === 'string') return obj.requirements;
    }
  } catch {
    // not JSON — fall through, return raw
  }
  return trimmed;
};
