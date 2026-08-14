import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { type DraftSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
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
 * `signals.json` per the audit-[09] contract, validates the file against the plan contract, and
 * parses the resolved task list (integration concern) onto `ctx.proposedTasks`.
 *
 * The leaf STOPS at the proposal. The deterministic critic (`check-plan`) and the HITL gate +
 * `draft → planned` transition (`apply-plan`) are separate downstream leaves — that split is what
 * lets the critic's findings reach the human BEFORE the approve/reject decision instead of after it.
 *
 * audit-[09] flow (post-Wave-6):
 *   provider.run → AI writes `signals.json` directly per the contract section in the
 *   prompt → `validateSignalsFile(planOutputContract)` → fan-out validated signals to the
 *   bus → `renderSidecars` (no-op, empty rules) → extract the `task-plan` payload's
 *   `tasksJson` and feed it into `parsePlanOutput`.
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
   * Default per-task attempt cap (`settings.harness.maxAttempts`) stamped onto every planned
   * task so the gen-eval loop, `failCurrentAttempt` block transition, and escalation
   * budget-exhausted branch all bound attempts. Threaded from the plan flow factory.
   */
  readonly maxAttempts: number;
}

interface CallPlannerInput {
  readonly sprint: DraftSprint;
  readonly project: Project;
  readonly cwd: AbsolutePath;
  readonly promptFile: AbsolutePath;
  readonly outputFile: AbsolutePath;
}

interface CallPlannerOutput {
  /** The planner's proposal — NOT yet approved, NOT yet persisted. */
  readonly tasks: readonly TodoTask[];
}

const isDraft = (s: Sprint): s is DraftSprint => s.status === 'draft';

/** Leaf name, reused as the `entity` / `attemptedAction` on the leaf's error states. */
const LEAF_NAME = 'call-planner-interactive';

/**
 * Phase 1 — hand the terminal to the AI, mounting every project repo as an equal
 * `--add-dir` source. On success resolves the per-unit output directory (the AI's
 * `signals.json` lands directly under it) so the next phase can validate it.
 */
const runInteractiveSession = async (
  deps: CallPlannerInteractiveDeps,
  input: CallPlannerInput,
  signal: AbortSignal | undefined
): Promise<Result<AbsolutePath, DomainError>> => {
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
      // Thread the leaf's abort signal so a TUI cancel tears the stdio-inherit child down
      // (attachAbortKill) rather than leaving it running — and the adapter classifies the
      // resulting non-zero exit as AbortError, not InvalidStateError.
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    })
  );
  if (!session.ok) return Result.error(session.error);

  // audit-[09]: the AI writes `signals.json` directly under the unit root per the
  // contract section in the prompt. The leaf validates that file.
  const outputDirRaw = dirname(String(input.outputFile));
  return AbsolutePath.parse(outputDirRaw);
};

/**
 * Phase 2 — validate the AI-written `signals.json` against the plan contract, fan every
 * validated signal out to the bus, render sidecars (none for plan today), then parse the
 * `task-plan` payload's `tasksJson` into the project/sprint's resolved task list.
 */
const validateAndParseOutput = async (
  deps: CallPlannerInteractiveDeps,
  input: CallPlannerInput,
  outputDir: AbsolutePath
): Promise<Result<readonly TodoTask[], DomainError>> => {
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
        entity: LEAF_NAME,
        currentState: 'post-validation',
        attemptedAction: 'project-signal',
        message: 'plan: validated signals contained no task-plan signal',
      })
    );
  }

  return parsePlanOutput(planSignal.tasksJson, {
    project: input.project,
    sprint: input.sprint,
    logger: deps.logger,
    defaultMaxAttempts: deps.maxAttempts,
  });
};

export const callPlannerInteractiveLeaf = (deps: CallPlannerInteractiveDeps): Element<PlanCtx> =>
  leaf<PlanCtx, CallPlannerInput, CallPlannerOutput>(LEAF_NAME, {
    useCase: {
      execute: async (input, signal) => {
        const outputDir = await runInteractiveSession(deps, input, signal);
        if (!outputDir.ok) return Result.error(outputDir.error);

        const tasks = await validateAndParseOutput(deps, input, outputDir.value);
        if (!tasks.ok) return Result.error(tasks.error);

        return Result.ok({ tasks: tasks.value });
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: LEAF_NAME,
          message: 'call-planner-interactive: ctx.sprint is undefined — load-sprint must run first',
        });
      }
      if (!isDraft(ctx.sprint)) {
        throw new InvalidStateError({
          entity: 'sprint',
          currentState: ctx.sprint.status,
          attemptedAction: LEAF_NAME,
          message: `call-planner-interactive: sprint must be draft — got '${ctx.sprint.status}'`,
        });
      }
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: LEAF_NAME,
          message: 'call-planner-interactive: ctx.project is undefined — load-project must run first',
        });
      }
      if (ctx.currentPromptFile === undefined || ctx.currentOutputFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: LEAF_NAME,
          message: 'call-planner-interactive: prompt/output paths missing — render-prompt-to-file must run first',
        });
      }
      if (ctx.currentUnitRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-plan',
          attemptedAction: LEAF_NAME,
          message: 'call-planner-interactive: unit root missing — build-plan-unit must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        project: ctx.project,
        cwd: ctx.currentUnitRoot,
        promptFile: ctx.currentPromptFile,
        outputFile: ctx.currentOutputFile,
      };
    },
    // Proposal only — `ctx.sprint` / `ctx.tasks` stay untouched until `apply-plan` runs the
    // human gate, so a rejected plan needs no rollback here.
    output: (ctx, out) => ({ ...ctx, proposedTasks: out.tasks }),
  });
