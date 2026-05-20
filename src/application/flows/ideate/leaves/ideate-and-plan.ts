import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { addApprovedTicketUseCase } from '@src/business/ticket/add-approved-ticket.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { DraftSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { createTicket, type ApprovedTicket } from '@src/domain/entity/ticket.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { parseIdeateOutput } from '@src/integration/ai/prompts/ideate/parse-output.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';

/**
 * The interactive ideate session: hands the terminal to Claude for the combined refine+plan
 * conversation, reads the JSON output file back, parses it (integration), then delegates the
 * ticket approval + sprint mutation to {@link addApprovedTicketUseCase}. Task merging is a
 * trivial array compose handled here.
 *
 * Failure modes (sprint untouched on each):
 *   - AI exits non-zero → bubbles its error.
 *   - Output file missing or empty → `InvalidStateError`.
 *   - Output file fails JSON parse / schema → `ParseError`.
 *   - Ticket validation fails (empty title etc.) → `ValidationError` from the domain.
 */
export interface IdeateAndPlanLeafDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  readonly model: string;
}

interface IdeateAndPlanInput {
  readonly sprint: Sprint;
  readonly project: Project;
  readonly sprintId: SprintId;
  readonly ideaTitle: string;
  readonly ideaText: string;
  readonly cwd: AbsolutePath;
  readonly promptFile: AbsolutePath;
  readonly outputFile: AbsolutePath;
  readonly existingTasks: readonly Task[];
}

interface IdeateAndPlanOutput {
  readonly sprint: DraftSprint;
  readonly ticket: ApprovedTicket;
  readonly tasks: readonly Task[];
}

export const ideateAndPlanLeaf = (deps: IdeateAndPlanLeafDeps): Element<IdeateCtx> =>
  leaf<IdeateCtx, IdeateAndPlanInput, IdeateAndPlanOutput>('ideate-and-plan', {
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

        let raw: string;
        try {
          raw = await fs.readFile(String(input.outputFile), 'utf8');
        } catch (cause) {
          const causeMsg = cause instanceof Error ? cause.message : String(cause);
          return Result.error(
            new InvalidStateError({
              entity: 'ideate-and-plan',
              currentState: 'post-session',
              attemptedAction: 'read-output',
              message: `ideate: AI exited but output file is missing: ${String(input.outputFile)} (${causeMsg})`,
            })
          );
        }
        if (raw.trim().length === 0) {
          return Result.error(
            new InvalidStateError({
              entity: 'ideate-and-plan',
              currentState: 'post-session',
              attemptedAction: 'parse-output',
              message: `ideate: AI exited but output file is empty: ${String(input.outputFile)}`,
            })
          );
        }

        const pending = createTicket({
          title: input.ideaTitle,
          ...(input.ideaText.trim().length > 0 ? { description: input.ideaText } : {}),
        });
        if (!pending.ok) return Result.error(pending.error);

        const parsed = parseIdeateOutput(raw, {
          project: input.project,
          sprintId: input.sprintId,
          ticketId: pending.value.id,
          // Pass the freshly minted ticket so any `externalRef` on it (currently unused by the
          // ideate input surface, but ready when added) propagates to every generated task.
          ticket: pending.value,
        });
        if (!parsed.ok) return Result.error(parsed.error);

        const added = addApprovedTicketUseCase({
          sprint: input.sprint,
          ticket: pending.value,
          requirementsBody: parsed.value.requirements,
          logger: deps.logger,
        });
        if (!added.ok) return Result.error(added.error);

        const tasks: readonly Task[] = [...input.existingTasks, ...parsed.value.tasks];
        return Result.ok({ sprint: added.value.sprint, ticket: added.value.ticket, tasks });
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-ideate',
          attemptedAction: 'ideate-and-plan',
          message: 'ideate-and-plan: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-ideate',
          attemptedAction: 'ideate-and-plan',
          message: 'ideate-and-plan: ctx.project is undefined — load-project must run first',
        });
      }
      if (ctx.currentPromptFile === undefined || ctx.currentOutputFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-ideate',
          attemptedAction: 'ideate-and-plan',
          message: 'ideate-and-plan: prompt/output paths missing — render-prompt-to-file must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        sprintId: ctx.sprintId,
        ideaTitle: ctx.ideaTitle,
        ideaText: ctx.ideaText,
        cwd: ctx.cwd,
        promptFile: ctx.currentPromptFile,
        outputFile: ctx.currentOutputFile,
        existingTasks: ctx.tasks ?? [],
      };
    },
    output: (ctx, out) => ({
      ...ctx,
      sprint: out.sprint,
      tasks: out.tasks,
      addedTicket: out.ticket,
    }),
  });
