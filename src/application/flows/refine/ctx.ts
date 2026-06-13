import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ApprovedTicket, PendingTicket } from '@src/domain/entity/ticket.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Context flowing through the refine chain. Optional fields are populated by upstream leaves —
 * `sprint` is set by `loadSprintLeaf`, `refinedTickets` accumulates as per-ticket sub-chains
 * succeed.
 *
 * Per-ticket scratch fields (`current*`) are set by the leaves at the head of each per-ticket
 * sub-chain (fetch-issue-context, build-refine-unit, render-prompt-to-file) and consumed by
 * the interactive-session leaf. `currentIssueContext` is reset on every ticket — fetch-issue-context
 * always sets it to the freshly-fetched body or to `undefined` (no link / soft-fail), so a linkless
 * ticket can never inherit the prior ticket's issue context.
 */
export interface RefineCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  /** Tickets approved during this run, in completion order. Used by the TUI to render progress. */
  readonly refinedTickets?: readonly ApprovedTicket[];
  /** Per-ticket scratch — pending ticket currently being refined. */
  readonly currentTicket?: PendingTicket;
  /**
   * Pre-fetched issue body (when `ticket.link` resolved) — formatted markdown ready for the prompt.
   * fetch-issue-context resets this per ticket: set to the freshly-fetched body, or dropped (made
   * absent) when the ticket has no resolvable issue, so a linkless ticket can never inherit the prior
   * ticket's context under the shared sequential ctx.
   */
  readonly currentIssueContext?: string;
  /** Per-ticket sandbox folder under `<sprintDir>/refinement/<ticket-slug>/`. */
  readonly currentUnitRoot?: AbsolutePath;
  /** `<unitRoot>/prompt.md` — written by render-prompt-to-file. */
  readonly currentPromptFile?: AbsolutePath;
  /** `<unitRoot>/requirements.md` — Claude writes here, harness reads back. */
  readonly currentOutputFile?: AbsolutePath;
}
