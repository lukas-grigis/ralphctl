import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';

/**
 * Narrow dependency contract for the add-tickets chain. Composition root constructs each field
 * from the integration layer (real repo, real `ConsolePrompt`, `IsoTimestamp.now`, log sink) and
 * passes the bag to `createAddTicketsFlow`.
 *
 * `clock` is included for parity with sibling chains even though pure ticket creation is
 * timestamp-free today — keeping the deps shape stable means future extensions (audit-stamping
 * tickets, recording a "last edited" cursor on the sprint) don't churn the wiring.
 */
export interface AddTicketsDeps {
  readonly sprintRepo: SprintRepository;
  readonly interactive: InteractivePrompt;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  /**
   * Optional GitHub/GitLab fetcher. When wired (see `wire.ts`), each loop iteration opens with
   * a URL prompt and pre-fills the edit form from the fetched issue. Omitted in headless / CI
   * runs without `gh`/`glab` installed — the loop runs manual-entry only.
   */
  readonly issueFetcher?: IssueFetcher;
}
