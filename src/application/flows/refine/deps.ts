import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Narrow dependency contract for the refine chain. Refine is **always interactive** — it
 * uses {@link InteractiveAiProvider} (not the headless `HeadlessAiProvider`), pauses the host
 * TUI via `runInTerminal` while Claude takes over the terminal, and reads the AI's output
 * from a file the harness wrote and the AI was told to write to.
 *
 * `issueFetcher` is optional — when omitted (e.g. tests, environments without `gh`/`glab`),
 * `fetch-issue-context` becomes a no-op and refine proceeds with no upstream context.
 */
export interface RefineDeps {
  readonly sprintRepo: SprintRepository;
  readonly interactiveAi: InteractiveAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly writeFile: WriteFile;
  readonly runInTerminal: RunInTerminal;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
  /**
   * ISO timestamp source — stamped onto the per-spawn `meta.json` sidecar so attribution
   * records when the AI session was kicked off.
   */
  readonly clock: () => IsoTimestamp;
  readonly issueFetcher?: IssueFetcher;
  /**
   * Optional pusher for the refine flow's "Approve & update origin" path. Same lifetime as
   * `issueFetcher`. Push failures are swallowed (log + continue) so a broken push never blocks
   * local refinement.
   */
  readonly issuePusher?: IssuePusher;
  /**
   * Project-level default origin for "Approve & create origin" when the ticket has no `link`.
   * Threaded down from the launcher (`snapshot.project.defaultIssueOrigin`). When unset, the
   * 3-way prompt collapses to 2 options for tickets without a link.
   */
  readonly defaultIssueOrigin?: IssueOriginRef;
  /**
   * Optional approval hook fired AFTER the AI proposes refined requirements and BEFORE the
   * ticket transitions to `approved`. Production wires this to a TUI review prompt;
   * headless / CI / tests omit it and the AI's body is auto-accepted.
   *
   * Return shape: `{accept, alsoUpdateOrigin?}`. The middle "Approve & update origin" path
   * sets `alsoUpdateOrigin: true`; the leaf then runs the push (best-effort).
   */
  readonly reviewBeforeApprove?: (
    proposed: string,
    ticket: PendingTicket
  ) => Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean }>;
}
