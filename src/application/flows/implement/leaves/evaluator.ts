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
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import {
  readRoundSessionId,
  roundEvaluationRelativePath,
  roundSignalsPath,
  writeEvaluatorRoundArtifacts,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';

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
 * The leaf reads `ctx.plateauHistory` (default `[]`) as `priorTurns` for plateau comparison,
 * appends the new turn record on completion, and writes the new evaluation back to
 * `ctx.lastEvaluation`. `ctx.proposedCommitMessage.subject` (the generator's same-round
 * `<commit-message>` signal) flows in as `currentCommitSubject`. When the use case returns a
 * terminal `exit`, the leaf writes the matching ctx fields so the surrounding `loop`'s
 * `shouldStop` predicate exits cleanly.
 */
export interface EvaluatorLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly cwd: AbsolutePath;
  readonly model: string;
  readonly verifyScript?: string;
  /** From `settings.harness.plateauThreshold` (2–5). */
  readonly plateauThreshold: number;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

interface EvaluatorInput {
  readonly task: InProgressTask;
  readonly priorTurns: readonly PlateauTurnRecord[];
  readonly currentCommitSubject?: string;
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
  /**
   * Captured Claude `session_id` from the prior round's evaluator turn for this task. Forwarded
   * to `implementSession({ resume })` so the reviewer continues a single conversational thread
   * across rounds. `undefined` on round 1 (or when the prior spawn failed before reporting an
   * id) → fresh session.
   */
  readonly priorEvaluatorSessionId?: SessionId;
}

interface EvaluatorOutput {
  readonly task: InProgressTask;
  readonly evaluation?: EvaluationSignal;
  readonly exit?: EvaluatorTurnExit;
  readonly turnRecord?: PlateauTurnRecord;
  /**
   * `session_id` captured by the Claude adapter for THIS turn — read from
   * `rounds/<N>/evaluator/sessionId` after the spawn returns. Stamped onto ctx by the output
   * projection so the next round's evaluator can resume the same thread.
   */
  readonly capturedSessionId?: SessionId;
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
            ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/evaluator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt on disk for post-hoc replay.
          // Best-effort: the writer logs and swallows on failure.
          await writeRoundPrompt(input.workspaceRoot, input.roundNum, 'evaluator', String(prompt.value), deps.logger);
          const signals = await consumeSignals(
            deps.provider,
            implementSession(
              input.workspaceRoot,
              deps.cwd,
              prompt.value,
              deps.model,
              signalsFile,
              input.priorEvaluatorSessionId
            ),
            deps.signals
          );
          if (!signals.ok) return Result.error(signals.error);
          lastSignals = signals.value;
          return Result.ok(signals.value);
        };

        const result = await runEvaluatorTurnUseCase({
          task: input.task,
          priorTurns: input.priorTurns,
          plateauThreshold: deps.plateauThreshold,
          ...(input.currentCommitSubject !== undefined ? { currentCommitSubject: input.currentCommitSubject } : {}),
          callEvaluate,
          evaluationFile: roundEvaluationRelativePath(input.roundNum),
          logger: deps.logger,
        });
        if (!result.ok) return Result.error(result.error);

        await writeEvaluatorRoundArtifacts(
          input.workspaceRoot,
          input.roundNum,
          lastSignals,
          deps.logger,
          input.task.name
        );

        // Read THIS turn's captured sessionId from disk (the Claude adapter just wrote it as a
        // sibling of `signals.json` via `persistSessionIdFile`). Undefined when the spawn never
        // reported an id — left undefined so the next round cold-starts cleanly.
        const capturedSessionId = await readRoundSessionId(input.workspaceRoot, input.roundNum, 'evaluator');

        return Result.ok({
          task: result.value.task,
          ...(result.value.evaluation !== undefined ? { evaluation: result.value.evaluation } : {}),
          ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
          ...(result.value.turnRecord !== undefined ? { turnRecord: result.value.turnRecord } : {}),
          ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
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
      const currentCommitSubject = ctx.proposedCommitMessage?.subject;
      return {
        task: ctx.currentTask,
        priorTurns: ctx.plateauHistory ?? [],
        workspaceRoot: ctx.taskWorkspaceRoot,
        roundNum: ctx.currentRoundNum,
        ...(currentCommitSubject !== undefined ? { currentCommitSubject } : {}),
        ...(ctx.priorEvaluatorSessionId !== undefined ? { priorEvaluatorSessionId: ctx.priorEvaluatorSessionId } : {}),
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
      const nextHistory =
        out.turnRecord !== undefined ? [...(ctx.plateauHistory ?? []), out.turnRecord] : ctx.plateauHistory;
      // Latest captured evaluator sessionId wins; only OVERWRITE when this turn produced one
      // (preserves the prior turn's thread when this spawn failed to report an id).
      const sessionCarry =
        out.capturedSessionId !== undefined ? { priorEvaluatorSessionId: out.capturedSessionId } : {};
      const next: ImplementCtx = {
        ...ctx,
        currentTask: out.task,
        tasks,
        ...(out.evaluation !== undefined ? { lastEvaluation: out.evaluation } : {}),
        ...(nextHistory !== undefined ? { plateauHistory: nextHistory } : {}),
        ...sessionCarry,
      };
      if (out.exit === undefined) return next;
      return { ...next, lastExit: out.exit };
    },
  });
