import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { addApprovedTicketUseCase } from '@src/business/ticket/add-approved-ticket.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { DraftSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { type ApprovedTicket, createTicket } from '@src/domain/entity/ticket.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IdeatedTicketsSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { parseIdeateOutput } from '@src/integration/ai/prompts/ideate/parse-output.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { ideateOutputContract } from '@src/application/flows/ideate/leaves/ideate.contract.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';

/**
 * The interactive ideate session: hands the terminal to Claude for the combined refine+plan
 * conversation, validates the AI-written `signals.json` against the audit-[09] ideate
 * contract, parses the resolved ticket + task envelope (integration), then delegates the
 * ticket approval + sprint mutation to {@link addApprovedTicketUseCase}.
 *
 * audit-[09] flow (post-Wave-6):
 *   provider.run → AI writes `signals.json` directly per the contract section in the
 *   prompt → `validateSignalsFile(ideateOutputContract)` → fan-out validated signals to the
 *   bus → `renderSidecars` (no-op, empty rules) → extract the `ideated-tickets` payload's
 *   `outputJson` → `parseIdeateOutput` → `addApprovedTicketUseCase`.
 *
 * Failure modes (sprint untouched on each):
 *   - AI exits non-zero → bubbles its error.
 *   - signals.json missing or schema-mismatched → `InvalidStateError` / `ParseError`.
 *   - `outputJson` fails parse — `ParseError`.
 *   - Ticket validation fails (empty title etc.) → `ValidationError` from the domain.
 */
export interface IdeateAndPlanLeafDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  /**
   * Output port used to write `signals.json` and any sidecars under the audit-[09] contract.
   * Ideate has no sidecars (the structured payload projects onto the sprint draft) but
   * threading `writeFile` keeps the contract loop uniform with other leaves.
   */
  readonly writeFile: WriteFile;
  /**
   * Application bus — every validated `ideated-tickets` / `learning` / `note` / `decision`
   * signal fans out as a typed `ai-signal` event the TUI subscribes to.
   */
  readonly eventBus: EventBus;
  readonly model: string;
  /** Optional reasoning / effort level forwarded to the AI CLI. */
  readonly effort?: string;
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
            ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
          })
        );
        if (!session.ok) return Result.error(session.error);

        // audit-[09]: the AI writes `signals.json` directly under the unit root per the
        // contract section in the prompt. The leaf validates that file.
        const outputDirRaw = dirname(String(input.outputFile));
        const outputDirResult = AbsolutePath.parse(outputDirRaw);
        if (!outputDirResult.ok) return Result.error(outputDirResult.error);
        const outputDir = outputDirResult.value;

        const validated = await validateSignalsFile(outputDir, ideateOutputContract);
        if (!validated.ok) return Result.error(validated.error);
        const signals = validated.value;

        for (const sig of signals) {
          deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'ideate' });
        }

        await renderSidecars(deps.writeFile, outputDir, signals, ideateOutputContract.sidecars, deps.logger);

        const ideatedSignal = signals.find((s) => s.type === 'ideated-tickets') as IdeatedTicketsSignal | undefined;
        if (ideatedSignal === undefined) {
          return Result.error(
            new InvalidStateError({
              entity: 'ideate-and-plan',
              currentState: 'post-validation',
              attemptedAction: 'project-signal',
              message: 'ideate: validated signals contained no ideated-tickets signal',
            })
          );
        }

        const pending = createTicket({
          title: input.ideaTitle,
          ...(input.ideaText.trim().length > 0 ? { description: input.ideaText } : {}),
        });
        if (!pending.ok) return Result.error(pending.error);

        const parsed = parseIdeateOutput(ideatedSignal.outputJson, {
          project: input.project,
          sprintId: input.sprintId,
          ticketId: pending.value.id,
          // Pass the freshly minted ticket so any `externalRef` on it (currently unused by the
          // ideate input surface, but ready when added) propagates to every generated task.
          ticket: pending.value,
          logger: deps.logger,
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
