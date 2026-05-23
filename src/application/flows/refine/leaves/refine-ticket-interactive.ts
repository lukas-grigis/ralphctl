import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { refineTicketUseCase } from '@src/business/ticket/refine-ticket.ts';
import { replaceTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import { setTicketLink, type ApprovedTicket, type PendingTicket, type Ticket } from '@src/domain/entity/ticket.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { RefinedTicketSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import { refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';

/**
 * Chain leaf — drives the user-in-the-loop AI session for one ticket. Integration work
 * (terminal hand-off, validate signals.json against the audit-[09] refine contract) lives
 * here; the business decision to approve the ticket and replace it on the sprint lives in
 * {@link refineTicketUseCase}.
 *
 * audit-[09] flow (post-Wave-6):
 *   provider.run → AI writes `signals.json` directly per the contract section in the
 *   prompt → `validateSignalsFile(refineOutputContract)` → fan-out validated signals to the
 *   bus → `renderSidecars` (no-op, empty rules) → extract the `refined-ticket` body and
 *   feed it into `refineTicketUseCase`.
 *
 * Failure modes (each leaves the sprint untouched):
 *   - AI exits non-zero → bubbles its error.
 *   - signals.json missing after AI exit → `InvalidStateError` (signals-missing path).
 *   - signals.json fails schema validation → `ParseError` (schema-mismatch) bubbles up.
 *   - Body fails domain validation → forwarded from the use case.
 */
export type RunInTerminal = <T>(fn: () => Promise<T>) => Promise<T>;

export interface RefineTicketInteractiveDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  /**
   * Output port used to write `signals.json` and any sidecars under the audit-[09] contract.
   * Refine has no sidecars (the refined body projects onto the Ticket entity), but the leaf
   * still threads `writeFile` so the contract's render path stays uniform with generator /
   * evaluator / readiness.
   */
  readonly writeFile: WriteFile;
  /**
   * Application bus — every validated `refined-ticket` / `learning` / `note` / `decision`
   * signal fans out as a typed `ai-signal` event the TUI subscribes to.
   */
  readonly eventBus: EventBus;
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
  readonly cwd: AbsolutePath;
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
            cwd: input.cwd,
            promptFile: input.promptFile,
            outputFile: input.outputFile,
            model: deps.model,
          })
        );
        if (!session.ok) return Result.error(session.error);

        // Resolve the outputDir from outputFile — `<sprintDir>/refinement/<ticket-slug>/`.
        // The audit-[09] contract has the AI write `signals.json` here directly.
        const outputDirRaw = dirname(String(input.outputFile));
        const outputDirResult = AbsolutePath.parse(outputDirRaw);
        if (!outputDirResult.ok) return Result.error(outputDirResult.error);
        const outputDir = outputDirResult.value;

        // Validate signals.json against the refine contract. Failure surfaces a domain error
        // (signals-missing / invalid-json / schema-mismatch / migration-gap) with a precise
        // hint.
        const validated = await validateSignalsFile(outputDir, refineOutputContract);
        if (!validated.ok) return Result.error(validated.error);
        const signals = validated.value;

        // Fan out every validated signal to the application bus so the TUI's `ai-signal`
        // subscribers render live updates. Source tag identifies the leaf for multi-leaf
        // traces.
        for (const sig of signals) {
          deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'refine' });
        }

        // Render harness-owned sidecars — refine has no sidecars (the contract's `sidecars`
        // is empty), but invoking the helper keeps the contract loop uniform with generator /
        // evaluator / readiness.
        await renderSidecars(deps.writeFile, outputDir, signals, refineOutputContract.sidecars, deps.logger);

        // Project the validated `refined-ticket` body onto the Ticket entity. The contract's
        // `exactlyOne` refinement guarantees one match; the type narrows here.
        const refinedSignal = signals.find((s) => s.type === 'refined-ticket') as RefinedTicketSignal | undefined;
        if (refinedSignal === undefined) {
          // Defensive — the schema should have caught this upstream.
          return Result.error(
            new InvalidStateError({
              entity: 'refine-ticket-interactive',
              currentState: 'post-validation',
              attemptedAction: 'project-signal',
              message: 'refine: validated signals contained no refined-ticket signal',
            })
          );
        }

        const useCaseResult = await refineTicketUseCase({
          sprint: input.sprint,
          ticket: input.ticket,
          requirementsBody: refinedSignal.body,
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
        const finalTicket = await maybePushOrigin(deps, approvedTicket, refinedSignal.body);
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
      if (ctx.currentUnitRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-refine',
          attemptedAction: `refine-ticket-${String(ticket.id)}`,
          message: `refine-ticket-${String(ticket.id)}: unit root missing — build-refine-unit must run first`,
        });
      }
      return {
        sprint: ctx.sprint,
        ticket,
        cwd: ctx.currentUnitRoot,
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
