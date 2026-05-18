import { join } from 'node:path';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { type PendingTicket, type Ticket } from '@src/domain/entity/ticket.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { toKebabCase } from '@src/domain/value/kebab-case.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import { buildUnitLeaf } from '@src/application/flows/_shared/build-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/flows/_shared/render-prompt-to-file.ts';
import type { RefineCtx } from '@src/application/flows/refine/ctx.ts';
import type { RefineDeps } from '@src/application/flows/refine/deps.ts';
import { fetchIssueContextLeaf } from '@src/application/flows/refine/leaves/fetch-issue-context.ts';
import { refineTicketInteractiveLeaf } from '@src/application/flows/refine/leaves/refine-ticket-interactive.ts';
import { buildRefinePrompt } from '@src/integration/ai/prompts/refine/definition.ts';
import { installSkillsLeaf } from '@src/application/flows/_shared/skills/install-skills.ts';
import { uninstallSkillsLeaf } from '@src/application/flows/_shared/skills/uninstall-skills.ts';

export interface CreateRefineFlowOpts {
  readonly sprintId: SprintId;
  /**
   * Pending tickets to refine, in processing order. Caller has already filtered the sprint's
   * tickets to `status === 'pending'`. The chain unrolls per-ticket sub-chains at construction
   * time so the trace names every ticket — a crash mid-run shows exactly which ticket failed.
   */
  readonly pendingTickets: readonly PendingTicket[];
  /** Working directory for the AI session — typically the repo root. */
  readonly cwd: AbsolutePath;
  /** Configured model for the refine chain. */
  readonly model: string;
  /** Per-sprint refinement directory: `<sprintDir>/refinement/`. The chain materialises per-ticket subfolders under it. */
  readonly refinementRoot: AbsolutePath;
}

/**
 * Build the refine chain.
 *
 * Shape:
 *
 *   sequential('refine', [
 *     load-and-assert-sprint(['draft']),
 *     sequential('refine-tickets', [
 *       sequential('refine-<ticket-id>', [
 *         fetch-issue-context-<id>,         // pre-fetch upstream issue body via gh/glab
 *         build-refine-unit-<id>,           // mkdir <refinementRoot>/<ticket-slug>/
 *         render-prompt-to-file-<id>,       // write prompt.md
 *         refine-ticket-<id>,               // hand TTY to Claude, await, read requirements.md back
 *         save-after-<id>,                  // persist sprint with the approved ticket
 *       ]),
 *       …,
 *     ]),
 *   ])
 *
 * Refine is always interactive: the user converses with the AI directly. The AI is told to
 * write its final markdown to `<unit-root>/requirements.md`, which the harness reads back
 * after the session exits.
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

  const perTicketChains: ReadonlyArray<Element<RefineCtx>> = opts.pendingTickets.map((ticket) =>
    sequential<RefineCtx>(`refine-${String(ticket.id)}`, [
      fetchIssueContextLeaf(
        { eventBus: deps.eventBus, ...(deps.issueFetcher !== undefined ? { issueFetcher: deps.issueFetcher } : {}) },
        ticket
      ),
      buildUnitLeaf<RefineCtx>({
        name: `build-refine-unit-${String(ticket.id)}`,
        parent: () => opts.refinementRoot,
        slug: () => ticketSlug(ticket),
        write: (ctx, root) => {
          const promptPath = AbsolutePath.parse(join(String(root), 'prompt.md'));
          const outputPath = AbsolutePath.parse(join(String(root), 'requirements.md'));
          if (!promptPath.ok || !outputPath.ok) {
            // Rare — `root` is already an AbsolutePath, so joining a basename produces an
            // absolute path. If the parser disagrees, surface as a chain abort.
            throw promptPath.ok ? (outputPath.ok ? new Error('unreachable') : outputPath.error) : promptPath.error;
          }
          return {
            ...ctx,
            currentUnitRoot: root,
            currentPromptFile: promptPath.value,
            currentOutputFile: outputPath.value,
          };
        },
      }),
      renderPromptToFileLeaf<RefineCtx>(
        { writeFile: deps.writeFile },
        {
          name: `render-prompt-to-file-${String(ticket.id)}`,
          path: (ctx) => {
            if (ctx.currentPromptFile === undefined) throw new Error('currentPromptFile missing');
            return ctx.currentPromptFile;
          },
          buildPrompt: (ctx) => {
            const outputFilePath = ctx.currentOutputFile;
            if (outputFilePath === undefined) throw new Error('currentOutputFile missing');
            return buildRefinePrompt(deps.templateLoader, {
              ticket,
              outputFilePath: String(outputFilePath),
              ...(ctx.currentIssueContext !== undefined ? { issueContext: ctx.currentIssueContext } : {}),
            });
          },
          write: (ctx, path) => ({ ...ctx, currentPromptFile: path }),
        }
      ),
      installSkillsLeaf<RefineCtx>(
        { skillsAdapter: deps.skillsAdapter, skillSource: deps.skillSource },
        {
          name: `install-skills-${String(ticket.id)}`,
          flowId: 'refine',
          // Skills land in the AI session's cwd (the repo) — the provider-native conventions
          // only auto-discover skills from cwd, not from `--add-dir` roots.
          cwdPicker: () => opts.cwd,
        }
      ),
      refineTicketInteractiveLeaf(
        {
          interactiveAi: deps.interactiveAi,
          runInTerminal: deps.runInTerminal,
          logger: deps.logger,
          cwd: opts.cwd,
          model: opts.model,
          ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
          ...(deps.issuePusher !== undefined ? { issuePusher: deps.issuePusher } : {}),
          ...(deps.defaultIssueOrigin !== undefined ? { defaultIssueOrigin: deps.defaultIssueOrigin } : {}),
        },
        ticket
      ),
      uninstallSkillsLeaf<RefineCtx>(
        { skillsAdapter: deps.skillsAdapter },
        { name: `uninstall-skills-${String(ticket.id)}`, cwdPicker: () => opts.cwd }
      ),
      saveSprintLeaf<RefineCtx>({ sprintRepo: deps.sprintRepo }, `save-after-${String(ticket.id)}`),
    ])
  );

  return sequential<RefineCtx>('refine', [
    loadAndAssertSprintSubChain<RefineCtx>({ sprintRepo: deps.sprintRepo }, ['draft']),
    sequential<RefineCtx>('refine-tickets', perTicketChains),
  ]);
};
