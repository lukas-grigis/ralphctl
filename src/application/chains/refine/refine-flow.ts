/**
 * `createRefineFlow` — build the chain definition for the refine workflow.
 *
 * Pure function: given the shared dependency graph + the workflow inputs,
 * returns a fresh `Element<RefineCtx>` ready to be launched via
 * `SessionManager.start({ element, initialCtx, label })`.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft → link-skills →
 *     refine-tickets (a Sequential of per-ticket sub-chains,
 *       each: refine-<id> → save-after-<id>)
 *   → unlink-skills
 *
 * Skills are linked even though refine is interview-mode — refined
 * requirements are stored as a structured artifact (per-ticket
 * `requirements.json` + `Ticket.requirements`), and skills like
 * "good-requirements" or "user-story-patterns" can shape the AI's
 * output quality even when no code is written.
 *
 * Per-ticket save persists the approved ticket BEFORE moving to the next
 * ticket, so a crash mid-flight resumes correctly. This is the entire
 * reason the per-ticket loop is unrolled at chain-construction time
 * rather than handled inside a single leaf — the chain trace shows
 * exactly which tickets succeeded and which one broke the run.
 *
 * The factory takes the *pre-loaded* list of pending tickets in `opts`
 * so step count is fixed at construction time. The `load-sprint` leaf at
 * the head of the chain re-loads from disk for transactional consistency
 * — the in-flight chain works against the freshly-loaded sprint, not the
 * factory-time snapshot.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import { RefineSingleTicketUseCase } from '@src/business/usecases/refine/refine-single-ticket.ts';
import { linkSkillsLeaf } from '@src/application/chains/leaves/link-skills.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { saveSprintLeaf } from '@src/application/chains/leaves/save-sprint.ts';
import { unlinkSkillsLeaf } from '@src/application/chains/leaves/unlink-skills.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';

/** Chain context for the refine flow. */
export interface RefineCtx {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly sprint?: Sprint;
  readonly refinedTickets?: readonly Ticket[];
  /**
   * When true, each per-ticket leaf hands the terminal to Claude
   * (`stdio: 'inherit'`) and reads the refined requirements back from
   * a JSON file the AI was instructed to write. Defaults to true on
   * TTY / Ink-mounted contexts; the launcher pins false in CI / auto.
   */
  readonly interactive?: boolean;
}

export interface CreateRefineFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  /**
   * Pending tickets to refine, in the order they should be processed.
   * Caller has already filtered to `requirementStatus === 'pending'`.
   * If empty, the chain still runs but the per-ticket Sequential is a
   * no-op.
   */
  readonly pendingTickets: readonly Ticket[];
  /**
   * When true, run the AI session interactively (Claude Code UI) and
   * read requirements back from a per-ticket file. When false (or on
   * non-TTY), spawn headless and parse stdout. Defaults to true.
   */
  readonly interactive?: boolean;
  /**
   * Required in interactive mode — function that hands the terminal
   * over to a child process for the duration of `fn`. The Ink runtime
   * supplies `runInteractive` from `application/runtime/interactive-terminal.ts`;
   * non-Ink contexts can pass a passthrough.
   */
  readonly runInTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Absolute base directory to write per-ticket interactive output
   * files to. Each ticket's file lives at
   * `<refinementOutputDir>/<ticketId>/requirements.json`. Required in
   * interactive mode.
   */
  readonly refinementOutputDir?: string;
}

export function createRefineFlow(
  deps: Pick<
    ChainSharedDeps,
    'sprintRepo' | 'aiSession' | 'prompts' | 'logger' | 'prompt' | 'external' | 'skillsLinker'
  >,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  const refineUseCase = new RefineSingleTicketUseCase(deps.aiSession, deps.prompts, deps.logger);

  const perTicketChains: Element<RefineCtx>[] = opts.pendingTickets.map((ticket) =>
    buildPerTicketChain(deps, refineUseCase, ticket, opts)
  );

  return new Sequential<RefineCtx>('refine', [
    loadSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf<RefineCtx>(),
    linkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }),
    new Sequential<RefineCtx>('refine-tickets', perTicketChains),
    unlinkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }),
  ]);
}

function buildPerTicketChain(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'aiSession' | 'prompts' | 'logger' | 'prompt' | 'external'>,
  refineUseCase: RefineSingleTicketUseCase,
  ticket: Ticket,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  const ticketShortId = ticket.id;
  return new Sequential<RefineCtx>(`refine-${ticketShortId}`, [
    refineTicketLeaf(deps, refineUseCase, ticket.id, opts),
    saveSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }, `save-after-${ticketShortId}`),
  ]);
}

/**
 * Wrap `RefineSingleTicketUseCase` as a Leaf. Threads the loaded sprint
 * through to the use case (the use case operates on the entity, not the
 * id), then writes the approved ticket back via `Sprint.replaceTicket`
 * so the saveSprint leaf that follows persists the updated aggregate.
 */
function refineTicketLeaf(
  deps: Pick<ChainSharedDeps, 'aiSession' | 'prompt' | 'logger' | 'external'>,
  useCase: RefineSingleTicketUseCase,
  ticketId: TicketId,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  return new Leaf<
    RefineCtx,
    {
      readonly sprint: Sprint;
      readonly ticket: Ticket;
      readonly cwd: AbsolutePath;
      readonly interactive: boolean;
    },
    Sprint
  >(`refine-${ticketId}`, {
    useCase: {
      async execute(input) {
        const ticketIdStr = String(input.ticket.id);

        // ── Pre-confirm (interactive only) ─────────────────────────
        // Per-ticket gate: "Start refinement session for this ticket?"
        // Headless / CI skips this gate. On
        // decline, leave the sprint unchanged so the chain advances to
        // the next ticket without crashing.
        //
        // ensureReady() must be awaited BEFORE reading any sync getter
        // on AiSessionPort — `getProviderDisplayName()` throws when
        // the underlying provider hasn't been resolved yet. The use
        // case awaits it again later, but it's idempotent so calling
        // here is safe.
        if (input.interactive) {
          await deps.aiSession.ensureReady();
          // No log line here — the use case logs `refining ticket <id> — "<title>"`
          // once the user confirms the prompt below, and the prompt itself names
          // the ticket. Two pre-AI log lines per ticket was just noise.
          const provider = deps.aiSession.getProviderDisplayName();
          const proceed = await deps.prompt.confirm({
            message: `Start ${provider} refinement session for [${ticketIdStr}] ${input.ticket.title}?`,
            default: true,
          });
          if (!proceed) {
            deps.logger.info(`refine: ticket ${ticketIdStr} skipped by user`);
            return Result.ok(input.sprint);
          }
        }

        // Build the per-ticket output file path. The directory follows
        // the storage layout convention from ARCHITECTURE.md (per-ticket
        // refinement subdir under the sprint dir).
        const outputFilePath =
          opts.refinementOutputDir !== undefined
            ? `${opts.refinementOutputDir}/${ticketIdStr}/requirements.json`
            : undefined;

        // The AI session's `Write` tool needs the parent directory to
        // already exist (Claude doesn't create intermediate dirs). And
        // the harness reads back the file Claude wrote — `readFile`
        // returns ENOENT if the dir was missing. Pre-create both.
        if (outputFilePath !== undefined) {
          await mkdir(dirname(outputFilePath), { recursive: true });
        }

        // ── Issue context fetch (when ticket carries a link) ───────
        // Try gh / glab via ExternalPort. Failures are non-fatal — we
        // log and proceed with the bare-link rendering so an offline
        // run still produces a usable session.
        let issueContext: string | undefined;
        if (input.ticket.link !== undefined) {
          deps.logger.info(`refine: fetching issue data for ticket ${ticketIdStr}`, { url: input.ticket.link });
          const fetched = await deps.external.fetchIssue(input.ticket.link);
          if (fetched.ok && fetched.value !== null) {
            issueContext = deps.external.formatIssueContext(fetched.value);
            deps.logger.info(`refine: issue fetched for ticket ${ticketIdStr}`, {
              comments: fetched.value.comments.length,
            });
          } else if (!fetched.ok) {
            deps.logger.warn(`refine: issue fetch failed for ticket ${ticketIdStr} (proceeding without)`, {
              error: fetched.error.message,
            });
          }
        }

        // ── Run AI session + post-AI approval ──────────────────────
        // Inject `reviewBeforeApprove` only in interactive mode. The
        // hook fires AFTER the AI has produced the proposal but BEFORE
        // ticket.approveRequirements runs, so the user reviews the
        // parsed body and can reject without persisting.
        const reviewBeforeApprove = input.interactive
          ? async (proposed: string): Promise<boolean> => {
              const accept = await deps.prompt.confirm({
                message: `Approve refined requirements for [${ticketIdStr}] ${input.ticket.title}?`,
                details: proposed,
                default: true,
              });
              return accept;
            }
          : undefined;

        const result = await useCase.execute({
          sprint: input.sprint,
          ticket: input.ticket,
          cwd: input.cwd,
          interactive: input.interactive,
          ...(outputFilePath !== undefined ? { outputFilePath } : {}),
          ...(opts.runInTerminal !== undefined ? { runInTerminal: opts.runInTerminal } : {}),
          ...(reviewBeforeApprove !== undefined ? { reviewBeforeApprove } : {}),
          ...(issueContext !== undefined ? { issueContext } : {}),
        });
        if (!result.ok) return Result.error(result.error);

        // Reviewer rejected: leave sprint unchanged, chain advances.
        if (!result.value.accepted) {
          deps.logger.info(`refine: requirements rejected by reviewer for ticket ${ticketIdStr}`);
          return Result.ok(input.sprint);
        }

        const replaced = input.sprint.replaceTicket(input.ticket.id, result.value.ticket);
        if (!replaced.ok) return Result.error(replaced.error);
        return Result.ok(replaced.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`refine-${ticketId}: ctx.sprint must be loaded`);
      }
      const ticket = ctx.sprint.ticketById(ticketId);
      if (!ticket) {
        throw new Error(`refine-${ticketId}: ticket no longer present on sprint`);
      }
      return {
        sprint: ctx.sprint,
        ticket,
        cwd: ctx.cwd,
        // ctx.interactive overrides the chain-level default per run.
        interactive: ctx.interactive ?? opts.interactive ?? false,
      };
    },
    output: (ctx, sprint) => {
      const updated = sprint.ticketById(ticketId);
      const refined = updated !== undefined ? [...(ctx.refinedTickets ?? []), updated] : (ctx.refinedTickets ?? []);
      return { ...ctx, sprint, refinedTickets: refined };
    },
  });
}

/**
 * Inline guard leaf — fails the chain when the loaded sprint is not
 * `draft`. Surfaces an `InvalidStateError` so the trace clearly shows
 * the precondition that broke.
 */
function assertDraftLeaf<TCtx extends { readonly sprint?: Sprint }>(): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint }, void>('assert-draft', {
    useCase: {
      async execute(input) {
        if (input.sprint.status !== 'draft') {
          return Promise.resolve(
            Result.error(
              new InvalidStateError({
                entity: 'sprint',
                currentState: input.sprint.status,
                attemptedAction: 'refine',
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error('assert-draft: ctx.sprint must be loaded first');
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
