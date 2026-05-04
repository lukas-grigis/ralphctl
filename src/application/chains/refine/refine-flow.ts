/**
 * `createRefineFlow` — build the chain definition for the refine workflow.
 *
 * Pure function: given the shared dependency graph + the workflow inputs,
 * returns a fresh `Element<RefineCtx>` ready to be launched via
 * `SessionManager.start({ element, initialCtx, label })`.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-draft →
 *     refine-tickets (a Sequential of per-ticket sub-chains,
 *       each: stage-ticket → build-refinement-unit → link-skills →
 *             render-prompt-to-file → refine-<id> → unlink-skills →
 *             save-after-<id> → export-sprint-requirements)
 *
 * `export-sprint-requirements` re-derives the canonical
 * `<sprintDir>/requirements.json` aggregate from the in-context sprint
 * after every per-ticket save. Only `requirementStatus === 'approved'`
 * tickets appear, so a ticket the user rejected (or one whose AI session
 * crashed) never lands in the aggregate. The plan flow copies this file
 * verbatim into `<sprintDir>/planning/requirements.json` — re-deriving on
 * each save means the planning copy is always fresh and never drifts
 * from `sprint.json`.
 *
 * Each ticket gets its own per-unit sandbox under
 * `<sprintDir>/refinement/<unit-slug>/`. The AI runs inside this folder,
 * reads `./ticket.md`, writes its raw output to `./requirements.json`, and
 * reads the rendered prompt from `./prompt.md`. Refine is
 * implementation-agnostic; it has no business reading or writing repo
 * code.
 *
 * The `render-prompt-to-file` leaf renders the FULL refine prompt
 * (with ticket body, refined-requirements schema, issue context) into
 * the unit folder. The downstream `refine-<id>` leaf hands the AI a
 * thin wrapper pointing at that file.
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
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import { RefineSingleTicketUseCase } from '@src/business/usecases/refine/refine-single-ticket.ts';
import { assertDraftLeaf } from '@src/application/chains/leaves/assert-draft.ts';
import { buildRefinementUnitLeaf } from '@src/application/chains/leaves/build-refinement-unit.ts';
import { exportSprintRequirementsLeaf } from '@src/application/chains/leaves/export-sprint-requirements.ts';
import { linkSkillsLeaf } from '@src/application/chains/leaves/link-skills.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { saveSprintLeaf } from '@src/application/chains/leaves/save-sprint.ts';
import { unlinkSkillsLeaf } from '@src/application/chains/leaves/unlink-skills.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';

/** Chain context for the refine flow. */
export interface RefineCtx {
  readonly sprintId: SprintId;
  /**
   * Sandbox workspace root. Set by the `build-refine-workspace` leaf
   * during the chain run — callers do NOT pass this as initial input.
   * Downstream leaves (skills install, AI session spawn, …) read from
   * here so every IO lands inside the sandbox rather than the user's
   * repo.
   */
  readonly cwd?: AbsolutePath;
  /**
   * Directory under the workspace containing pre-staged
   * `<ticket-id>.md` files the AI reads as input. Set alongside `cwd`
   * by the `build-refine-workspace` leaf.
   */
  readonly refineTicketsDir?: AbsolutePath;
  readonly sprint?: Sprint;
  readonly refinedTickets?: readonly Ticket[];
  /**
   * When true, each per-ticket leaf hands the terminal to Claude
   * (`stdio: 'inherit'`) and reads the refined requirements back from
   * a JSON file the AI was instructed to write. Defaults to true on
   * TTY / Ink-mounted contexts; the launcher pins false in CI / auto.
   */
  readonly interactive?: boolean;
  /**
   * The ticket currently being processed by the per-ticket sub-chain.
   * Set ahead of `render-prompt-to-file` so the leaf can read the
   * ticket fields when calling `prompts.buildRefinePrompt(...)`.
   */
  readonly currentTicket?: Ticket;
  /**
   * Pre-fetched issue context for the current ticket (when its `link`
   * field is set + `gh`/`glab` returned a body). Threaded into the
   * refine prompt build via the `render-prompt-to-file` leaf.
   */
  readonly currentIssueContext?: string;
  /**
   * Resolved per-ticket prompt file path. Set by `render-prompt-to-file`
   * inside each per-ticket sub-chain; consumed by `refine-<id>`.
   */
  readonly promptFilePath?: AbsolutePath;
  /**
   * Per-ticket refinement unit root. Set by `build-refinement-unit`;
   * the per-ticket leaf reads `<root>/session.md` from
   * {@link refinementSessionMdPath} and threads it into the AI session
   * for audit recording.
   */
  readonly refinementUnitRoot?: AbsolutePath;
  /**
   * Audit `session.md` path under the per-ticket refinement unit. Set
   * by `build-refinement-unit`; consumed by the per-ticket leaf to pass
   * into the AI session adapter as `SessionOptions.sessionMdPath`.
   */
  readonly refinementSessionMdPath?: AbsolutePath;
  /**
   * `<unit-root>/requirements.json` — where the AI is told to write its
   * raw output. Set by `build-refinement-unit`; consumed by
   * `render-prompt-to-file` (substitutes `OUTPUT_FILE`) and the
   * per-ticket `refine-<id>` leaf (passed to the use case as the
   * read-back path in interactive mode).
   */
  readonly refinementRequirementsJsonPath?: AbsolutePath;
}

export interface CreateRefineFlowOpts {
  readonly sprintId: SprintId;
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
}

export function createRefineFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'aiSession'
    | 'prompts'
    | 'logger'
    | 'prompt'
    | 'external'
    | 'skillsLinker'
    | 'writeContextFile'
    | 'sessionFolderBuilder'
  >,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  const refineUseCase = new RefineSingleTicketUseCase(deps.aiSession, deps.logger);

  const perTicketChains: Element<RefineCtx>[] = opts.pendingTickets.map((ticket) =>
    buildPerTicketChain(deps, refineUseCase, ticket, opts)
  );

  return new Sequential<RefineCtx>('refine', [
    loadSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }),
    assertDraftLeaf<RefineCtx>('refine'),
    new Sequential<RefineCtx>('refine-tickets', perTicketChains),
  ]);
}

function buildPerTicketChain(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'aiSession'
    | 'prompts'
    | 'logger'
    | 'prompt'
    | 'external'
    | 'skillsLinker'
    | 'writeContextFile'
    | 'sessionFolderBuilder'
  >,
  refineUseCase: RefineSingleTicketUseCase,
  ticket: Ticket,
  opts: CreateRefineFlowOpts
): Element<RefineCtx> {
  const ticketShortId = ticket.id;
  return new Sequential<RefineCtx>(`refine-${ticketShortId}`, [
    // Stage the current ticket onto the context + fetch issue context so
    // the build leaf below has the full input bag.
    stageTicketLeaf(deps, ticket),
    buildRefinementUnitLeaf<RefineCtx>({
      sessionFolderBuilder: deps.sessionFolderBuilder,
      aiSession: deps.aiSession,
    }),
    linkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }, { phase: 'refine' }),
    renderPromptToFileLeaf<RefineCtx>(
      { writeContextFile: deps.writeContextFile },
      {
        flowName: 'refine',
        identifier: () => String(ticket.id),
        path: (ctx) => {
          if (!ctx.refinementUnitRoot) {
            throw new Error(`refine-${String(ticket.id)}: ctx.refinementUnitRoot must be set by build-refinement-unit`);
          }
          return AbsolutePath.trustString(join(String(ctx.refinementUnitRoot), 'prompt.md'));
        },
        buildPrompt: (ctx) => {
          const outputFilePath =
            ctx.refinementRequirementsJsonPath !== undefined ? String(ctx.refinementRequirementsJsonPath) : undefined;
          return deps.prompts.buildRefinePrompt({
            ticket,
            ...(outputFilePath !== undefined ? { outputFilePath } : {}),
            ...(ctx.currentIssueContext !== undefined ? { issueContext: ctx.currentIssueContext } : {}),
          });
        },
      }
    ),
    refineTicketLeaf(deps, refineUseCase, ticket.id, opts),
    unlinkSkillsLeaf<RefineCtx>({ skillsLinker: deps.skillsLinker }),
    saveSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }, `save-after-${ticketShortId}`),
    exportSprintRequirementsLeaf<RefineCtx>({ writeContextFile: deps.writeContextFile }),
  ]);
}

/**
 * Stage the current ticket on the chain context so the
 * `render-prompt-to-file` leaf below can read it. Also fetches the
 * upstream issue context (when the ticket carries a link) so the
 * refine prompt sees the actual issue body, not just the URL.
 *
 * Leaf name is intentionally not in the locked step trace — it sits
 * inside the per-ticket sub-chain and the trace already names the
 * sub-chain by id (`refine-<ticket-id>`).
 */
function stageTicketLeaf(deps: Pick<ChainSharedDeps, 'logger' | 'external'>, ticket: Ticket): Element<RefineCtx> {
  return new Leaf<RefineCtx, { readonly sprint: Sprint }, { readonly issueContext: string | undefined }>(
    'stage-ticket',
    {
      useCase: {
        async execute() {
          let issueContext: string | undefined;
          if (ticket.link !== undefined) {
            deps.logger.info(`refine: fetching issue data for ticket ${String(ticket.id)}`, { url: ticket.link });
            const fetched = await deps.external.fetchIssue(ticket.link);
            if (fetched.ok && fetched.value !== null) {
              issueContext = deps.external.formatIssueContext(fetched.value);
              deps.logger.info(`refine: issue fetched for ticket ${String(ticket.id)}`, {
                comments: fetched.value.comments.length,
              });
            } else if (!fetched.ok) {
              deps.logger.warn(`refine: issue fetch failed for ticket ${String(ticket.id)} (proceeding without)`, {
                error: fetched.error.message,
              });
            }
          }
          return Result.ok({ issueContext });
        },
      },
      input: (ctx) => {
        if (!ctx.sprint) {
          throw new Error(`stage-ticket: ctx.sprint must be loaded`);
        }
        return { sprint: ctx.sprint };
      },
      output: (ctx, out) => ({
        ...ctx,
        currentTicket: ticket,
        ...(out.issueContext !== undefined ? { currentIssueContext: out.issueContext } : {}),
      }),
    }
  );
}

/**
 * Wrap `RefineSingleTicketUseCase` as a Leaf. Threads the loaded sprint
 * through to the use case (the use case operates on the entity, not the
 * id), then writes the approved ticket back via `Sprint.replaceTicket`
 * so the saveSprint leaf that follows persists the updated aggregate.
 */
function refineTicketLeaf(
  deps: Pick<ChainSharedDeps, 'aiSession' | 'prompt' | 'logger'>,
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
      readonly promptFilePath: AbsolutePath;
      readonly outputFilePath: AbsolutePath;
      readonly sessionMdPath?: AbsolutePath;
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

        // The AI writes its output inside the unit folder
        // (`<unit-root>/requirements.json`); the unit dir already exists
        // from `build-refinement-unit`, no pre-mkdir needed.
        const outputFilePath = String(input.outputFilePath);

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
          promptFilePath: String(input.promptFilePath),
          interactive: input.interactive,
          outputFilePath,
          ...(opts.runInTerminal !== undefined ? { runInTerminal: opts.runInTerminal } : {}),
          ...(reviewBeforeApprove !== undefined ? { reviewBeforeApprove } : {}),
          ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
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
      if (!ctx.promptFilePath) {
        throw new Error(`refine-${ticketId}: ctx.promptFilePath must be set by render-prompt-to-file`);
      }
      if (!ctx.cwd) {
        throw new Error(`refine-${ticketId}: ctx.cwd must be set by build-refinement-unit`);
      }
      if (!ctx.refinementRequirementsJsonPath) {
        throw new Error(`refine-${ticketId}: ctx.refinementRequirementsJsonPath must be set by build-refinement-unit`);
      }
      return {
        sprint: ctx.sprint,
        ticket,
        cwd: ctx.cwd,
        // ctx.interactive overrides the chain-level default per run.
        interactive: ctx.interactive ?? opts.interactive ?? false,
        promptFilePath: ctx.promptFilePath,
        outputFilePath: ctx.refinementRequirementsJsonPath,
        ...(ctx.refinementSessionMdPath !== undefined ? { sessionMdPath: ctx.refinementSessionMdPath } : {}),
      };
    },
    output: (ctx, sprint) => {
      const updated = sprint.ticketById(ticketId);
      const refined = updated !== undefined ? [...(ctx.refinedTickets ?? []), updated] : (ctx.refinedTickets ?? []);
      return { ...ctx, sprint, refinedTickets: refined };
    },
  });
}
