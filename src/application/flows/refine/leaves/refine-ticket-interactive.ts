import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { refineTicketUseCase } from '@src/business/ticket/refine-ticket.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { type ApprovedTicket, type PendingTicket, type Ticket } from '@src/domain/entity/ticket.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { RefinedTicketSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import { partitionRefineSignals, refineOutputContract } from '@src/application/flows/refine/leaves/refine.contract.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';

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
   * Optional reasoning / effort level — resolved per launch by the harness via
   * `resolveEffort(flowId, settings)` and forwarded to the AI CLI. Adapters that don't
   * expose a reasoning flag silently ignore it.
   */
  readonly effort?: string;
  /**
   * Optional human-in-the-loop approval callback wired by the flow factory. The launcher
   * threads in a TUI prompt that shows the proposed requirements and asks accept/reject.
   * When omitted (tests, headless) the use case auto-accepts the AI's body.
   */
  readonly reviewBeforeApprove?: (
    proposed: string,
    ticket: PendingTicket
  ) => Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean; readonly body?: string }>;
  /**
   * Optional pusher. When the reviewer picks "Post as comment" (or, in non-interactive runs,
   * `postRefinementComment` is enabled), the leaf posts the refined requirements as a comment
   * on the linked issue here. Any failure is swallowed (logged, but the leaf still completes
   * successfully — local refinement always lands).
   */
  readonly issuePusher?: IssuePusher;
  /**
   * Sprint identifier — embedded in the comment signature so a reader can trace a posted
   * comment back to the sprint that produced it.
   */
  readonly sprintId: string;
  /**
   * Non-interactive default for posting the refined requirements as a comment. Consulted only
   * when `reviewBeforeApprove` is absent (CI / headless): when `true` and the ticket has a
   * link, the comment is posted without prompting; otherwise nothing is pushed. When the
   * reviewer hook IS wired, the reviewer's explicit choice governs instead.
   */
  readonly postRefinementComment?: boolean;
}

/**
 * Signature appended to every posted comment so a reader can recognise it as ralphctl-authored
 * and trace it back to the sprint that produced it. Format stays consistent across every
 * comment: a divider, the ralphctl link, the sprint id, and the post timestamp.
 */
const REFINEMENT_COMMENT_SIGNATURE = (sprintId: string, timestamp: string): string =>
  `\n\n---\n_🤖 Posted by [ralphctl](https://github.com/lukas-grigis/ralphctl) · Sprint ${sprintId} · ${timestamp}_`;

/**
 * Refine-specific signals-missing message. The shared `validateSignalsFile` hint is generic
 * ("inspect the per-spawn directory…"); for refine the common real cause is the user exiting
 * the interactive AI session before it finished writing `signals.json`. Rewrite the
 * `signals-missing` error with an actionable, refine-framed message so the TUI's failure card
 * tells the user exactly what happened and what to do — the ticket is untouched, re-run and let
 * the AI finish. Every other error (invalid-json / schema-mismatch / migration-gap / I/O, and
 * `AbortError` if it ever reached here) passes through verbatim.
 */
const remapRefineSignalsError = <E extends { readonly message?: string }>(error: E): E => {
  if (error instanceof InvalidStateError && error.message.includes('signals-missing')) {
    return new InvalidStateError({
      entity: 'refine-ticket-interactive',
      currentState: 'post-spawn',
      attemptedAction: 'validate-signals',
      message:
        'Refinement not saved — the AI session ended before writing signals.json. The ticket is unchanged; re-run refine and let the AI finish writing before you exit.',
      hint: 'The interactive AI must write signals.json (carrying the refined-ticket) before it exits. Closing the session early leaves nothing for the harness to read.',
    }) as unknown as E;
  }
  return error;
};

/**
 * Best-effort warn-log for malformed auxiliary signals the lenient refine contract dropped.
 * `validateSignalsFile` only returns the survivors, so to name what was discarded the leaf
 * re-reads `signals.json` and runs the same per-element partition the contract schema uses
 * (see {@link partitionRefineSignals}). Diagnostics only — never blocks refinement and never
 * throws; any read / parse hiccup here is swallowed (the authoritative validation already
 * succeeded by the time this runs).
 */
const warnDroppedSignals = async (deps: RefineTicketInteractiveDeps, outputDir: AbsolutePath): Promise<void> => {
  try {
    const bytes = await fs.readFile(join(String(outputDir), 'signals.json'), 'utf8');
    // Why: diagnostics-only re-read of a file the authoritative validator
    // (`validateSignalsFile`) already parsed + Zod-validated. The narrow guards below
    // (`Array.isArray`, `typeof === 'object'`) handle any unexpected shape; the partition
    // helper exits cleanly on non-array payloads.
    const raw: unknown = JSON.parse(bytes);
    // Legacy bare-array shape (migrations[0] target) or the canonical { signals } wrapper.
    const inner = Array.isArray(raw) ? raw : (raw as { signals?: unknown }).signals;
    if (!Array.isArray(inner)) return;
    // Match `validateSignalsFile`'s timestamp leniency so a signal missing only `timestamp`
    // (which the validator stamps and keeps) is not mis-reported here as dropped.
    const now = new Date().toISOString();
    const defaulted = inner.map((sig) => {
      if (typeof sig !== 'object' || sig === null) return sig;
      const s = sig as Record<string, unknown>;
      return typeof s.timestamp === 'string' && s.timestamp.length > 0 ? sig : { ...s, timestamp: now };
    });
    const { dropped } = partitionRefineSignals(defaulted);
    if (dropped.length === 0) return;
    const summary = dropped.map((d) => `[${String(d.index)}] type=${d.type ?? '?'} (${d.reason})`).join('; ');
    deps.logger
      .named('refine.signals')
      .warn(`dropped ${String(dropped.length)} malformed auxiliary signal(s) — refinement kept`, {
        dropped: summary,
      });
  } catch {
    // Diagnostics only — never let a re-read failure disturb a successful refinement.
  }
};

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
 * Best-effort comment on the linked issue. Posts the refined requirements (plus a ralphctl
 * signature) as a NEW comment — the issue description is never modified. The ticket is returned
 * unchanged either way. On failure, logs a warning. Never throws; never aborts the chain.
 *
 * Only the ticket's existing `link` is targeted: a ticket with no link has nothing to comment
 * on, so the leaf skips silently (the launcher already hides the option in that case).
 */
const maybeCommentOnOrigin = async (
  deps: RefineTicketInteractiveDeps,
  ticket: ApprovedTicket,
  body: string
): Promise<void> => {
  if (deps.issuePusher === undefined) {
    deps.logger.named('refine.push').warn('no IssuePusher wired — skipping issue comment');
    return;
  }
  if (ticket.link === undefined) {
    deps.logger.named('refine.push').warn('comment requested but ticket has no link — skipping');
    return;
  }
  const now = new Date().toISOString();
  const fullBody = `${body}${REFINEMENT_COMMENT_SIGNATURE(deps.sprintId, now)}`;
  const url = String(ticket.link);
  const result = await deps.issuePusher.comment(url, { body: fullBody });
  if (!result.ok) {
    deps.logger.named('refine.push').warn(`issue comment failed (${url}): ${result.error.message}`);
  } else {
    deps.logger.named('refine.push').info(`posted comment on issue ${url}`);
  }
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
            ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
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
        // hint. The refine contract is resilient — malformed auxiliary signals are dropped, not
        // fatal — so the only validation failures left are genuine: a missing file, unparseable
        // JSON, or zero / two valid `refined-ticket` entries.
        const validated = await validateSignalsFile(outputDir, refineOutputContract);
        if (!validated.ok) return Result.error(remapRefineSignalsError(validated.error));
        const signals = validated.value;

        // Diagnostics — name any malformed auxiliary signals the lenient contract just dropped.
        // Refinement still succeeds; the warn keeps the drop out of the silent zone.
        await warnDroppedSignals(deps, outputDir);

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
        if (!out.accepted) return Result.ok(out);
        // Decide whether to post a comment on the linked issue. With a reviewer hook wired the
        // reviewer's explicit choice (`alsoUpdateOrigin`) governs; in non-interactive runs the
        // `postRefinementComment` setting governs. Commenting never mutates the ticket, so the
        // sprint is returned exactly as the use case produced it.
        const shouldComment =
          deps.reviewBeforeApprove !== undefined ? out.alsoUpdateOrigin : deps.postRefinementComment === true;
        if (!shouldComment) return Result.ok(out);
        // Post the SETTLED requirements — `refineTicketUseCase` stored the reviewer's edited body
        // (when they edited it) on the approved ticket. Posting `refinedSignal.body` (the AI's raw
        // pre-edit proposal) would publish text the reviewer may have deliberately discarded to a
        // public issue tracker, diverging from the locally-persisted ticket. `out.accepted` is true
        // here, so `out.ticket` is an `ApprovedTicket` and `requirements` is a non-empty string.
        const approved = out.ticket as ApprovedTicket;
        await maybeCommentOnOrigin(deps, approved, approved.requirements);
        return Result.ok(out);
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
