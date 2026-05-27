import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { planSprintUseCase } from '@src/business/sprint/plan-sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp as IsoTimestampType } from '@src/domain/value/iso-timestamp.ts';
import type { TaskPlanSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { parsePlanOutput } from '@src/integration/ai/prompts/plan/parse-output.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { planOutputContract } from '@src/application/flows/plan/leaves/plan.contract.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';

/**
 * Interactive plan session: hands the terminal to Claude, waits for the AI to write
 * `signals.json` per the audit-[09] contract, validates the file against the plan contract,
 * parses the resolved task list (integration concern), then delegates to {@link planSprintUseCase}
 * for the `draft → planned` transition.
 *
 * audit-[09] flow (post-Wave-6):
 *   provider.run → AI writes `signals.json` directly per the contract section in the
 *   prompt → `validateSignalsFile(planOutputContract)` → fan-out validated signals to the
 *   bus → `renderSidecars` (no-op, empty rules) → extract the `task-plan` payload's
 *   `tasksJson` and feed it into `parsePlanOutput` → `planSprintUseCase`.
 *
 * Failure modes (each leaves disk state untouched):
 *   - AI exits non-zero → bubbles its error.
 *   - signals.json missing or malformed → `InvalidStateError` / `ParseError`.
 *   - Task JSON shape-mismatched → `ParseError` from the parser.
 *   - AI emitted `{ "blocked": "..." }` in `tasksJson` → `InvalidStateError({ entity: 'plan', currentState: 'blocked' })`.
 *   - `ticketRef` not in the sprint's approved tickets → `ParseError`.
 *   - `projectPath` not in the project's repos → `ParseError`.
 */
export interface CallPlannerInteractiveDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly logger: Logger;
  /**
   * Output port used to write `signals.json` and any sidecars under the audit-[09] contract.
   * Plan has no sidecars (the structured tasks project onto the sprint), but threading
   * `writeFile` keeps the contract loop uniform with other leaves.
   */
  readonly writeFile: WriteFile;
  /**
   * Application bus — every validated `task-plan` / `learning` / `note` / `decision` signal
   * fans out as a typed `ai-signal` event the TUI subscribes to.
   */
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestampType;
  /**
   * Repo roots mounted as equal `--add-dir` sources alongside the per-sprint plan unit root.
   * The plan flow passes every repository on the project so the AI can navigate across a
   * multi-repo codebase without per-file approval prompts during interview-style planning.
   */
  readonly additionalRoots?: readonly AbsolutePath[];
  readonly model: string;
  /** Optional reasoning / effort level — adapter-specific; ignored when the CLI has no flag for it. */
  readonly effort?: string;
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
  readonly cwd: AbsolutePath;
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
            cwd: input.cwd,
            promptFile: input.promptFile,
            outputFile: input.outputFile,
            model: deps.model,
            ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
            ...(additionalRoots.length > 0 ? { additionalRoots } : {}),
          })
        );
        if (!session.ok) return Result.error(session.error);

        // audit-[09]: the AI writes `signals.json` directly under the unit root per the
        // contract section in the prompt. The leaf validates that file.
        const outputDirRaw = dirname(String(input.outputFile));
        const outputDirResult = AbsolutePath.parse(outputDirRaw);
        if (!outputDirResult.ok) return Result.error(outputDirResult.error);
        const outputDir = outputDirResult.value;

        const validated = await validateSignalsFile(outputDir, planOutputContract);
        if (!validated.ok) return Result.error(validated.error);
        const signals = validated.value;

        for (const sig of signals) {
          deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'plan' });
        }

        await renderSidecars(deps.writeFile, outputDir, signals, planOutputContract.sidecars, deps.logger);

        const planSignal = signals.find((s) => s.type === 'task-plan') as TaskPlanSignal | undefined;
        if (planSignal === undefined) {
          return Result.error(
            new InvalidStateError({
              entity: 'call-planner-interactive',
              currentState: 'post-validation',
              attemptedAction: 'project-signal',
              message: 'plan: validated signals contained no task-plan signal',
            })
          );
        }

        const parsed = parsePlanOutput(planSignal.tasksJson, {
          project: input.project,
          sprint: input.sprint,
          logger: deps.logger,
        });
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
      if (ctx.currentUnitRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: 'call-planner-interactive',
          message: 'call-planner-interactive: unit root missing — build-plan-unit must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        existingTasks: ctx.tasks ?? [],
        cwd: ctx.currentUnitRoot,
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
