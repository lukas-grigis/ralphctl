import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import {
  type EvaluatorTurnExit,
  type RunEvaluatorTurnProps,
  runEvaluatorTurnUseCase,
} from '@src/business/task/run-evaluator-turn.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal, EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import { buildEvaluatePrompt } from '@src/integration/ai/prompts/evaluate/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import {
  readRoundSessionId,
  roundEvaluationRelativePath,
  roundSignalsPath,
  writeRoundPrompt,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';

/**
 * Chain leaf — one evaluator turn of the gen-eval loop. Wires the integration ports
 * (`provider`, `templateLoader`, `signals`, `writeFile`, `eventBus`) into function-shape deps
 * for {@link runEvaluatorTurnUseCase}; the use case owns the per-turn business decisions
 * (evaluation recording, plateau detection, malformed detection, critique recording).
 *
 * File-based contract (audit-[09]): the leaf reuses the generator's `ctx.currentRoundNum` so
 * generator and evaluator artifacts share the round folder. `session.signalsFile =
 * <workspaceRoot>/rounds/<N>/evaluator/signals.json` is set on the provider call; after the
 * call the leaf {@link validateSignalsFile validates} the file against
 * {@link evaluatorOutputContract}, fans every validated signal out to both the legacy
 * `HarnessSignalSink` (TUI panels, decisions-log) and the application `eventBus` as a typed
 * `ai-signal` event, then renders the harness-owned `evaluation.md` sidecar via
 * {@link renderSidecars}. The leaf no longer constructs `evaluation.md` directly — sidecar
 * rendering is the only writer.
 *
 * The leaf reads `ctx.plateauHistory` (default `[]`) as `priorTurns` for plateau comparison,
 * appends the new turn record on completion, and writes the new evaluation back to
 * `ctx.lastEvaluation`. `ctx.proposedCommitMessage.subject` (the generator's same-round
 * `commit-message` signal) flows in as `currentCommitSubject`. When the use case returns a
 * terminal `exit`, the leaf writes the matching ctx fields so the surrounding `loop`'s
 * `shouldStop` predicate exits cleanly.
 */
export interface EvaluatorLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  /**
   * Output port used to write harness-rendered sidecars (`evaluation.md`) post-spawn. Per
   * audit-[09], the AI only writes `signals.json`; the harness derives every other on-
   * disk artifact from the validated signal array. Threaded through from the flow factory's
   * `deps.writeFile` (atomic write-to-temp+rename in production; in-memory recorder in tests).
   */
  readonly writeFile: WriteFile;
  readonly cwd: AbsolutePath;
  /**
   * Sprint directory — mounted as a second `--add-dir` on every implement spawn so the AI
   * can read sprint-wide artifacts (`progress.md` in particular) that live outside the
   * per-task sandbox. Threaded down from the flow factory.
   */
  readonly sprintDir: AbsolutePath;
  /**
   * Absolute path to `<sprintDir>/progress.md` — the reviewer reads the current journal body
   * pre-spawn and inlines it into the `## Prior progress` section of the evaluator prompt so
   * the reviewer can judge this round's work against what already shipped (mirrors the
   * generator's prior-progress wiring).
   */
  readonly progressFile: AbsolutePath;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into every `implementSession` AiSession. */
  readonly effort?: string;
  readonly verifyScript?: string;
  /** From `settings.harness.plateauThreshold` (2–5). */
  readonly plateauThreshold: number;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /**
   * Application bus used to publish each validated `ai-signal` event under the audit-[09]
   * contract. Consumers (TUI panels, persistent `chain.log`, future progress.md miners)
   * receive the typed signal verbatim along with `source: 'evaluator'` so a multi-leaf flow's
   * events stay attributable. Mirrors the generator-leaf wiring.
   */
  readonly eventBus: EventBus;
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

/**
 * Read the current `progress.md` body to inline into the evaluator prompt. Best-effort: a
 * missing / unreadable file returns the empty string so the template's surrounding prose
 * handles the empty case without a per-flow special branch. Mirrors the generator-leaf
 * helper of the same name so both sides of the gen-eval loop see the same journal body.
 */
const readProgressFile = async (path: string): Promise<string> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
};

export const evaluatorLeaf = (deps: EvaluatorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, EvaluatorInput, EvaluatorOutput>(`evaluator-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const signalsFilePath = AbsolutePath.parse(roundSignalsPath(input.workspaceRoot, input.roundNum, 'evaluator'));
        if (!signalsFilePath.ok) return Result.error(signalsFilePath.error);
        const signalsFile = signalsFilePath.value;

        // `outputDir` is the per-round directory (`rounds/<N>/evaluator/`);
        // `validateSignalsFile` resolves `<outputDir>/signals.json` and `renderSidecars`
        // writes harness-rendered sidecars into the same directory. We derive it once from
        // `signalsFile` so the two paths stay structurally coupled.
        const outputDirPath = AbsolutePath.parse(dirname(String(signalsFile)));
        if (!outputDirPath.ok) return Result.error(outputDirPath.error);
        const outputDir = outputDirPath.value;

        const callEvaluate: RunEvaluatorTurnProps['callEvaluate'] = async (task) => {
          // Inline the current progress.md body into the prompt. Best-effort — a missing or
          // unreadable file degrades to empty, which the template's surrounding prose handles
          // without a special branch. Mirrors the generator-leaf wiring.
          const priorProgress = await readProgressFile(String(deps.progressFile));
          const prompt = await buildEvaluatePrompt(deps.templateLoader, {
            task,
            projectPath: String(deps.cwd),
            contractPath: join(String(input.workspaceRoot), 'contract.md'),
            outputContractSection: renderContractSectionFor(evaluatorOutputContract, outputDir),
            priorProgress,
            ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/evaluator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt on disk for post-hoc replay.
          // Best-effort: the writer logs and swallows on failure.
          await writeRoundPrompt(input.workspaceRoot, input.roundNum, 'evaluator', String(prompt.value), deps.logger);

          const spawn = await deps.provider.generate(
            implementSession(
              input.workspaceRoot,
              deps.cwd,
              deps.sprintDir,
              prompt.value,
              deps.model,
              signalsFile,
              input.priorEvaluatorSessionId,
              deps.effort
            )
          );
          if (!spawn.ok) return Result.error(spawn.error);

          // Validate `signals.json` against the evaluator contract. Failure surfaces a
          // domain error (signals-missing / invalid-json / schema-mismatch / migration-gap)
          // with a precise hint — the surrounding loop's critique injection picks it up on
          // the next round.
          const validated = await validateSignalsFile(outputDir, evaluatorOutputContract);
          if (!validated.ok) return Result.error(validated.error);
          const signals = validated.value;

          // Fan out to BOTH the legacy `HarnessSignalSink` (TUI panels, decisions-log) and
          // the application bus's typed `ai-signal` event. The bus carries every kind the
          // contract accepts; the sink keeps its existing per-kind consumers happy until
          // Wave 6 collapses the two paths.
          for (const sig of signals) {
            deps.signals.emit(sig);
            deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'evaluator' });
          }

          // Render harness-owned sidecars (`evaluation.md`). Write failures log warn inside
          // `renderSidecars`; the helper always returns `Result.ok` (sidecars are operator UX
          // only — `runEvaluatorTurnUseCase` consumes the in-memory `evaluation` signal, never
          // the rendered file).
          await renderSidecars(deps.writeFile, outputDir, signals, evaluatorOutputContract.sidecars, deps.logger);

          // `runEvaluatorTurnUseCase` expects `readonly HarnessSignal[]`. `EvaluatorContractSignal`
          // is a strict subset of `HarnessSignal`, but TS's array variance doesn't infer that
          // automatically — cast through `AiSignal[]` (the canonical union alias) to keep the
          // call site honest about the underlying domain shape.
          return Result.ok(signals as readonly AiSignal[]) as Result<readonly HarnessSignal[], DomainError>;
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
