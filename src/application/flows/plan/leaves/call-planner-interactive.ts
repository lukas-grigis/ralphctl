import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { planSprintUseCase } from '@src/business/sprint/plan-sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { parsePlanOutput } from '@src/integration/ai/prompts/plan/parse-output.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';

/**
 * Interactive plan session: hands the terminal to Claude, waits for the AI to write its
 * task-array JSON, parses it (integration concern), then delegates to {@link planSprintUseCase}
 * for the `draft → planned` transition.
 *
 * Failure modes (each leaves disk state untouched):
 *   - AI exits non-zero → bubbles its error.
 *   - Output file missing or empty → `InvalidStateError`.
 *   - Output JSON malformed or shape-mismatched → `ParseError` from the parser.
 *   - AI emitted `{ "blocked": "..." }` → `InvalidStateError({ entity: 'plan', currentState: 'blocked' })`.
 *   - `ticketRef` not in the sprint's approved tickets → `ParseError`.
 *   - `projectPath` not in the project's repos → `ParseError`.
 */
export interface CallPlannerInteractiveDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
  readonly cwd: AbsolutePath;
  /**
   * Extra repo roots to mount alongside `cwd`. The plan flow passes every repository on the
   * project so the AI can navigate across a multi-repo codebase without per-file approval
   * prompts during interview-style planning. Adapter folds duplicates with `cwd`.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  readonly model: string;
  /**
   * Optional human-in-the-loop approval callback wired by the flow factory. The launcher
   * threads in a TUI prompt that summarises the proposed task list and asks accept/reject.
   * When omitted (tests, headless) the AI's plan is auto-accepted.
   */
  readonly reviewBeforeApprove?: (
    proposedTasks: readonly TodoTask[],
    sprint: DraftSprint
  ) => Promise<{ readonly accept: boolean }>;
}

interface CallPlannerInput {
  readonly sprint: DraftSprint;
  readonly project: Project;
  readonly existingTasks: readonly Task[];
  readonly promptFile: AbsolutePath;
  readonly outputFile: AbsolutePath;
}

interface CallPlannerOutput {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  /** `false` when the reviewer rejected the proposed plan; the chain leaves the sprint draft. */
  readonly accepted: boolean;
}

const isDraft = (s: Sprint): s is DraftSprint => s.status === 'draft';

export const callPlannerInteractiveLeaf = (deps: CallPlannerInteractiveDeps): Element<PlanCtx> =>
  leaf<PlanCtx, CallPlannerInput, CallPlannerOutput>('call-planner-interactive', {
    useCase: {
      execute: async (input) => {
        // `additionalRoots` are the project repos the AI may navigate. The output-file dir
        // is auto-mounted by the interactive adapter itself, so we don't repeat that here.
        const additionalRoots = deps.additionalRoots ?? [];

        const session = await deps.runInTerminal(async () =>
          deps.interactiveAi.run({
            cwd: deps.cwd,
            promptFile: input.promptFile,
            outputFile: input.outputFile,
            model: deps.model,
            ...(additionalRoots.length > 0 ? { additionalRoots } : {}),
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
              entity: 'call-planner-interactive',
              currentState: 'post-session',
              attemptedAction: 'read-output',
              message: `plan: AI exited but output file is missing: ${String(input.outputFile)} (${causeMsg})`,
            })
          );
        }
        if (raw.trim().length === 0) {
          return Result.error(
            new InvalidStateError({
              entity: 'call-planner-interactive',
              currentState: 'post-session',
              attemptedAction: 'parse-output',
              message: `plan: AI exited but output file is empty: ${String(input.outputFile)}`,
            })
          );
        }

        const parsed = parsePlanOutput(raw, { project: input.project, sprint: input.sprint });
        if (!parsed.ok) return Result.error(parsed.error);

        return planSprintUseCase({
          sprint: input.sprint,
          existingTasks: input.existingTasks,
          tasks: parsed.value,
          clock: deps.clock,
          logger: deps.logger,
          ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
        });
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: 'call-planner-interactive',
          message: 'call-planner-interactive: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      if (!isDraft(ctx.sprint)) {
        throw new InvalidStateError({
          entity: 'sprint',
          currentState: ctx.sprint.status,
          attemptedAction: 'call-planner-interactive',
          message: `call-planner-interactive: sprint must be draft — got '${ctx.sprint.status}'`,
        });
      }
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: 'call-planner-interactive',
          message: 'call-planner-interactive: ctx.project is undefined — load-project must run first',
        });
      }
      if (ctx.currentPromptFile === undefined || ctx.currentOutputFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: 'call-planner-interactive',
          message: 'call-planner-interactive: prompt/output paths missing — render-prompt-to-file must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        existingTasks: ctx.tasks ?? [],
        promptFile: ctx.currentPromptFile,
        outputFile: ctx.currentOutputFile,
      };
    },
    output: (ctx, out) => {
      // On reject, leave ctx.sprint as the original DraftSprint (the use case returns the
      // input sprint unchanged) and don't stamp `plannedTasks` — downstream `save-tasks` and
      // `save-sprint` then write the unchanged sprint + existing task list (no-op).
      if (!out.accepted) return { ...ctx, sprint: out.sprint, tasks: out.tasks };
      return { ...ctx, sprint: out.sprint, tasks: out.tasks, plannedTasks: out.tasks as readonly TodoTask[] };
    },
  });
