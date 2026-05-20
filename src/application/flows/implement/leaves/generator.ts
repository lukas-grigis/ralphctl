import { Result } from '@src/domain/result.ts';
import {
  type GeneratorTurnExit,
  type RunGeneratorTurnProps,
  runGeneratorTurnUseCase,
} from '@src/business/task/run-generator-turn.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type InProgressTask, latestCritique } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import {
  nextRoundNum,
  roundSignalsPath,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — one generator turn of the gen-eval loop. Wires the integration ports
 * (`provider`, `templateLoader`, `signals`) into function-shape deps for
 * {@link runGeneratorTurnUseCase}; the use case owns the per-turn business decisions
 * (self-blocked detection + verification recording).
 *
 * File-based contract: the leaf computes this turn's round number BEFORE the provider call so
 * `session.signalsFile = <workspaceRoot>/rounds/<N>/generator/signals.json` is in place when
 * the provider writes. After the call returns the leaf reads that file, forwards each parsed
 * signal to the harness sink (TUI + progress.md fan-out), then passes the array to the use
 * case. The AI's raw prose is never materialised in node memory at this layer.
 *
 * The leaf increments `ctx.genEvalTurn` at the start so downstream consumers can report
 * "budget-exhausted at turn N". When the generator self-blocks, the leaf writes
 * `lastExitKind` + `lastBlockReason` to ctx so the surrounding `loop`'s `shouldStop` predicate
 * exits cleanly without running the evaluator.
 */
export interface GeneratorLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly cwd: AbsolutePath;
  readonly model: string;
  readonly checkScript?: string;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /**
   * Application bus used to publish the discrete `task-round-started` boundary marker. The
   * trace records back-to-back `generator-<id>` / `evaluator-<id>` leaves with no round number;
   * this event lets the TUI's per-task round counter survive `chain.trace` ring eviction
   * without counting trace entries (which silently shrink as eviction proceeds).
   */
  readonly eventBus: EventBus;
  /**
   * Configured gen-eval-loop budget (`settings.harness.maxTurns`). Stamped onto every
   * `task-round-started` event so subscribers can render `round N/M` without a second config
   * lookup; matches the value the surrounding `loop`'s `shouldContinue` predicate enforces.
   */
  readonly maxTurns: number;
}

interface GeneratorInput {
  readonly task: InProgressTask;
  readonly turn: number;
  readonly progressFile: AbsolutePath;
  readonly workspaceRoot: AbsolutePath;
}

interface GeneratorOutput {
  readonly task: InProgressTask;
  readonly turn: number;
  readonly exit?: GeneratorTurnExit;
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  /** On-disk round folder index written by this turn — `rounds/<N>/generator/`. */
  readonly roundNum: number;
}

export const generatorLeaf = (deps: GeneratorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, GeneratorInput, GeneratorOutput>(`generator-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const roundNum = await nextRoundNum(input.workspaceRoot);
        const signalsFilePath = AbsolutePath.parse(roundSignalsPath(input.workspaceRoot, roundNum, 'generator'));
        if (!signalsFilePath.ok) return Result.error(signalsFilePath.error);
        const signalsFile = signalsFilePath.value;

        // Discrete boundary marker — fired BEFORE the AI call so the TUI's per-task round
        // counter and the persistent `chain.log` see the round-start before any of its
        // generator-leaf trace entries. `attemptN` is `task.attempts.length`: the running
        // attempt was already started by `start-attempt-<taskId>` upstream, so this counts the
        // n-th attempt-within-task (1-indexed; matches `task.maxAttempts`).
        deps.eventBus.publish({
          type: 'task-round-started',
          taskId: String(taskId),
          attemptN: input.task.attempts.length,
          roundN: roundNum,
          totalCap: deps.maxTurns,
          at: deps.clock(),
        });
        deps.logger
          .named('task.round-started')
          .info(`round ${String(roundNum)}/${String(deps.maxTurns)} of attempt ${String(input.task.attempts.length)}`, {
            taskId: input.task.id,
            attemptN: input.task.attempts.length,
            roundN: roundNum,
            totalCap: deps.maxTurns,
          });

        const callImplement: RunGeneratorTurnProps['callImplement'] = async (task) => {
          const priorCritique = latestCritique(task);
          const prompt = await buildImplementPrompt(deps.templateLoader, {
            task,
            projectPath: String(deps.cwd),
            progressFile: String(input.progressFile),
            ...(deps.checkScript !== undefined ? { checkScript: deps.checkScript } : {}),
            ...(priorCritique !== undefined ? { priorCritique } : {}),
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/generator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt that triggered it on disk for
          // post-hoc replay. Best-effort: the writer logs and swallows on failure (the audit
          // trail must never take down the chain).
          await writeRoundPrompt(input.workspaceRoot, roundNum, 'generator', String(prompt.value), deps.logger);
          return consumeSignals(
            deps.provider,
            implementSession(input.workspaceRoot, deps.cwd, prompt.value, deps.model, signalsFile),
            deps.signals
          );
        };

        const result = await runGeneratorTurnUseCase({
          task: input.task,
          callImplement,
          logger: deps.logger,
        });
        if (!result.ok) return Result.error(result.error);

        return Result.ok({
          task: result.value.task,
          turn: input.turn,
          roundNum,
          ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
          ...(result.value.proposedCommitMessage !== undefined
            ? { proposedCommitMessage: result.value.proposedCommitMessage }
            : {}),
        });
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generator',
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: expected in_progress task`,
        });
      }
      if (ctx.progressFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generator',
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.progressFile missing — ensureProgressFileLeaf must run first`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generator',
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.taskWorkspaceRoot missing — buildTaskWorkspaceLeaf must run first`,
        });
      }
      return {
        task: ctx.currentTask,
        turn: (ctx.genEvalTurn ?? 0) + 1,
        progressFile: ctx.progressFile,
        workspaceRoot: ctx.taskWorkspaceRoot,
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
      // Latest non-undefined proposed commit message wins across turns.
      const proposedCommitMessage = out.proposedCommitMessage ?? ctx.proposedCommitMessage;
      const carry = proposedCommitMessage !== undefined ? { proposedCommitMessage } : {};
      if (out.exit !== undefined) {
        return {
          ...ctx,
          currentTask: out.task,
          tasks,
          genEvalTurn: out.turn,
          currentRoundNum: out.roundNum,
          lastExit: { kind: 'self-blocked', reason: out.exit.reason },
          lastBlockReason: out.exit.reason,
          ...carry,
        };
      }
      return {
        ...ctx,
        currentTask: out.task,
        tasks,
        genEvalTurn: out.turn,
        currentRoundNum: out.roundNum,
        ...carry,
      };
    },
  });
