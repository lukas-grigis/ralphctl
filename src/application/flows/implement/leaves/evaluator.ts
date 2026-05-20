import { Result } from '@src/domain/result.ts';
import {
  type EvaluatorTurnExit,
  type RunEvaluatorTurnProps,
  runEvaluatorTurnUseCase,
} from '@src/business/task/run-evaluator-turn.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import { buildEvaluatePrompt } from '@src/integration/ai/prompts/evaluate/definition.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import {
  roundEvaluationRelativePath,
  roundSignalsPath,
  writeEvaluatorRoundArtifacts,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Chain leaf — one evaluator turn of the gen-eval loop. Wires the integration ports
 * (`provider`, `templateLoader`, `signals`) into function-shape deps for
 * {@link runEvaluatorTurnUseCase}; the use case owns the per-turn business decisions
 * (evaluation recording, plateau detection, malformed detection, critique recording).
 *
 * File-based contract: the leaf reuses the generator's `ctx.currentRoundNum` so generator and
 * evaluator artifacts share the round folder. `session.signalsFile =
 * <workspaceRoot>/rounds/<N>/evaluator/signals.json` is set on the provider call; after the
 * call the leaf reads the file, fans signals out to the sink, then passes the parsed array to
 * the use case. The leaf finishes by rendering `evaluation.md` for operator-facing replay.
 *
 * The leaf reads `ctx.lastEvaluation` as `priorEvaluation` for plateau comparison and writes
 * the new evaluation back to `ctx.lastEvaluation` for next turn. When the use case returns a
 * terminal `exit`, the leaf writes the matching ctx fields so the surrounding `loop`'s
 * `shouldStop` predicate exits cleanly.
 */
export interface EvaluatorLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly cwd: AbsolutePath;
  readonly model: string;
  readonly checkScript?: string;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

interface EvaluatorInput {
  readonly task: InProgressTask;
  readonly priorEvaluation?: EvaluationSignal;
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
}

interface EvaluatorOutput {
  readonly task: InProgressTask;
  readonly evaluation?: EvaluationSignal;
  readonly exit?: EvaluatorTurnExit;
}

export const evaluatorLeaf = (deps: EvaluatorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, EvaluatorInput, EvaluatorOutput>(`evaluator-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const signalsFilePath = AbsolutePath.parse(roundSignalsPath(input.workspaceRoot, input.roundNum, 'evaluator'));
        if (!signalsFilePath.ok) return Result.error(signalsFilePath.error);
        const signalsFile = signalsFilePath.value;
        let lastSignals: readonly HarnessSignal[] = [];

        const callEvaluate: RunEvaluatorTurnProps['callEvaluate'] = async (task) => {
          const prompt = await buildEvaluatePrompt(deps.templateLoader, {
            task,
            projectPath: String(deps.cwd),
            ...(deps.checkScript !== undefined ? { checkScript: deps.checkScript } : {}),
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/evaluator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt on disk for post-hoc replay.
          // Best-effort: the writer logs and swallows on failure.
          await writeRoundPrompt(input.workspaceRoot, input.roundNum, 'evaluator', String(prompt.value), deps.logger);
          const signals = await consumeSignals(
            deps.provider,
            implementSession(input.workspaceRoot, deps.cwd, prompt.value, deps.model, signalsFile),
            deps.signals
          );
          if (!signals.ok) return Result.error(signals.error);
          lastSignals = signals.value;
          return Result.ok(signals.value);
        };

        const result = await runEvaluatorTurnUseCase({
          task: input.task,
          ...(input.priorEvaluation !== undefined ? { priorEvaluation: input.priorEvaluation } : {}),
          callEvaluate,
          evaluationFile: roundEvaluationRelativePath(input.roundNum),
          logger: deps.logger,
        });
        if (!result.ok) return Result.error(result.error);

        await writeEvaluatorRoundArtifacts(input.workspaceRoot, input.roundNum, lastSignals, deps.logger);

        return Result.ok({
          task: result.value.task,
          ...(result.value.evaluation !== undefined ? { evaluation: result.value.evaluation } : {}),
          ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
        });
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-evaluator',
          attemptedAction: `evaluator-${String(taskId)}`,
          message: `evaluator-${String(taskId)}: ctx.currentTask missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `evaluator-${String(taskId)}`,
          message: `evaluator-${String(taskId)}: expected in_progress task`,
        });
      }
      if (ctx.taskWorkspaceRoot === undefined || ctx.currentRoundNum === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-evaluator',
          attemptedAction: `evaluator-${String(taskId)}`,
          message: `evaluator-${String(taskId)}: ctx.taskWorkspaceRoot/currentRoundNum missing — generator leaf must run first`,
        });
      }
      return {
        task: ctx.currentTask,
        workspaceRoot: ctx.taskWorkspaceRoot,
        roundNum: ctx.currentRoundNum,
        ...(ctx.lastEvaluation !== undefined ? { priorEvaluation: ctx.lastEvaluation } : {}),
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
      const next: ImplementCtx = {
        ...ctx,
        currentTask: out.task,
        tasks,
        ...(out.evaluation !== undefined ? { lastEvaluation: out.evaluation } : {}),
      };
      if (out.exit === undefined) return next;
      return { ...next, lastExit: out.exit };
    },
  });
