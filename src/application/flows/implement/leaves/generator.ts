import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import {
  type GeneratorTurnExit,
  type RunGeneratorTurnProps,
  runGeneratorTurnUseCase,
} from '@src/business/task/run-generator-turn.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { latestCritique } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal, HarnessSignal, LearningEntry } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { implementSession } from '@src/application/flows/implement/leaves/implement-session.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import { escalationBannerId } from '@src/business/task/escalation-policy.ts';
import {
  readRoundSessionId,
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
  /**
   * Output port used to write harness-rendered sidecars (`commit-message.txt`) post-spawn.
   * Per audit-[09], the AI only writes `signals.json`; the harness derives every other on-
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
   * Absolute path to `<sprintDir>/progress.md` — passed straight to `buildImplementPrompt`'s
   * `progressFile` slot so the AI's prompt names the journal file it must read for prior
   * context (audit-[07]). The file is materialised by `create-sprint`'s init-progress-journal
   * leaf and grows append-only thereafter; the implement chain never writes the header itself.
   */
  readonly progressFile: AbsolutePath;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into every `implementSession` AiSession. */
  readonly effort?: string;
  readonly verifyScript?: string;
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
  readonly workspaceRoot: AbsolutePath;
  /**
   * Round number for this turn — resolved upstream by `resolve-round-num-<taskId>` and
   * threaded through ctx. Single source of truth across the round's stamp + generator +
   * evaluator leaves so the meta sidecar and the spawn share the same `<N>`.
   */
  readonly roundNum: number;
  /**
   * Captured Claude `session_id` from the prior round's generator turn for this task. Forwarded
   * to `implementSession({ resume })` so the model continues a single conversational thread
   * across rounds. `undefined` on round 1 of a task (or when the prior spawn failed before
   * reporting an id) → fresh session.
   */
  readonly priorGeneratorSessionId?: SessionId;
}

interface GeneratorOutput {
  readonly task: InProgressTask;
  readonly turn: number;
  readonly exit?: GeneratorTurnExit;
  readonly proposedCommitMessage?: { readonly subject: string; readonly body?: string };
  /** On-disk round folder index written by this turn — `rounds/<N>/generator/`. */
  readonly roundNum: number;
  /**
   * `session_id` captured by the Claude adapter for THIS turn — read from
   * `rounds/<N>/generator/session-id.txt` after the spawn returns. Stamped onto ctx by the output
   * projection so the next round's generator can resume the same thread. `undefined` when the
   * adapter never reported an id (failed spawn, non-Claude provider, …).
   */
  readonly capturedSessionId?: SessionId;
  /**
   * Decision-signal bodies emitted by this turn. Empty array when the generator emitted no
   * `<decision>` signals. Accumulates onto `ctx.currentAttemptDecisions` so the journal leaf
   * can render a deduped `### Decisions` subsection for the attempt (audit-[07] — replaces
   * the deleted `decisions-log` sink with an in-memory aggregate).
   */
  readonly decisionsEmitted: readonly string[];
  /**
   * Change-signal bodies emitted by this turn — accumulates onto `ctx.currentAttemptChanges`
   * so the journal leaf can render the per-attempt `### Changes` subsection.
   */
  readonly changesEmitted: readonly string[];
  /**
   * Structured learnings emitted by this turn — each a {@link LearningEntry} (Insight + optional
   * Context + optional Applies-to). Accumulates onto `ctx.currentAttemptLearnings` so the journal
   * leaf can render the per-attempt `### Learnings` subsection and `append-learnings` can persist
   * the procedural-memory ledger rows.
   */
  readonly learningsEmitted: readonly LearningEntry[];
  /**
   * Note-signal bodies emitted by this turn — accumulates onto `ctx.currentAttemptNotes`
   * so the journal leaf can render the per-attempt `### Notes` subsection.
   */
  readonly notesEmitted: readonly string[];
}

/**
 * Read the current `progress.md` body to inline into the prompt. Best-effort: a missing /
 * unreadable file returns the empty string so the template's surrounding prose handles the
 * empty case without a per-flow special branch.
 */
const readProgressFile = async (path: string): Promise<string> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
};

export const generatorLeaf = (deps: GeneratorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, GeneratorInput, GeneratorOutput>(`generator-${String(taskId)}`, {
    useCase: {
      execute: async (input, signal) => {
        const roundNum = input.roundNum;
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
        // Release any prior escalation banner — once a new generator round starts on this
        // task, the operator-facing "escalated to <model>" message has served its purpose and
        // shouldn't hang around blocking the banner slot. Idempotent against an absent banner.
        deps.eventBus.publish({
          type: 'banner-clear',
          id: escalationBannerId(String(taskId)),
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

        // `outputDir` is the per-round directory (`rounds/<N>/generator/`); `validateSignalsFile`
        // resolves `<outputDir>/signals.json` and `renderSidecars` writes harness-rendered
        // sidecars into the same directory. We derive it once from `signalsFile` so the two
        // paths stay structurally coupled.
        const outputDirPath = AbsolutePath.parse(dirname(String(signalsFile)));
        if (!outputDirPath.ok) return Result.error(outputDirPath.error);
        const outputDir = outputDirPath.value;

        // Per-turn signal accumulators — closure-captured so the leaf can stamp the
        // emitted texts onto ctx in `output(...)`. The journal leaf reads the aggregate
        // across all gen-eval rounds for the attempt.
        const decisionsEmitted: string[] = [];
        const changesEmitted: string[] = [];
        const learningsEmitted: LearningEntry[] = [];
        const notesEmitted: string[] = [];
        const callImplement: RunGeneratorTurnProps['callImplement'] = async (task) => {
          const priorCritique = latestCritique(task);
          // Inline the current progress.md body into the prompt (audit-[07]). Best-effort —
          // a missing or unreadable file degrades to empty, which the template's surrounding
          // prose handles without a special branch.
          const priorProgress = await readProgressFile(String(deps.progressFile));
          const prompt = await buildImplementPrompt(deps.templateLoader, {
            task,
            projectPath: String(deps.cwd),
            contractPath: join(String(input.workspaceRoot), 'contract.md'),
            progressFile: String(deps.progressFile),
            priorProgress,
            outputContractSection: renderContractSectionFor(generatorOutputContract, outputDir),
            ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
            ...(priorCritique !== undefined ? { priorCritique } : {}),
            // Plateau-break attempt: the escalation policy stamped the task (model bump and/or a
            // change-of-approach nudge) after the gen-eval loop stalled. Surface the "change your
            // approach" directive so the generator abandons the non-converging path.
            ...(task.escalatedFromModel !== undefined ? { plateauBreak: true } : {}),
          });
          if (!prompt.ok) return Result.error(prompt.error) as Result<readonly HarnessSignal[], DomainError>;
          // Persist the rendered prompt under `rounds/<N>/generator/prompt.md` BEFORE the AI
          // call so a crash mid-spawn still leaves the prompt that triggered it on disk for
          // post-hoc replay. Best-effort: the writer logs and swallows on failure (the audit
          // trail must never take down the chain).
          await writeRoundPrompt(input.workspaceRoot, roundNum, 'generator', String(prompt.value), deps.logger);

          // Per-task generator-model escalation: when the task carries an `escalatedToModel`
          // (stamped by the prior plateau's escalation policy), spawn the generator on that
          // upgraded model instead of the configured row. Evaluator model is intentionally
          // unaffected — escalation only touches the generator role.
          const effectiveModel = task.escalatedToModel ?? deps.model;
          const spawn = await deps.provider.generate(
            implementSession(
              input.workspaceRoot,
              deps.cwd,
              deps.sprintDir,
              prompt.value,
              effectiveModel,
              signalsFile,
              'generator',
              input.priorGeneratorSessionId,
              deps.effort,
              signal
            )
          );
          if (!spawn.ok) return Result.error(spawn.error);

          // Validate `signals.json` against the generator contract. Failure surfaces a
          // domain error (signals-missing / invalid-json / schema-mismatch / migration-gap)
          // with a precise hint. `runGeneratorTurnUseCase` converts a recoverable validation
          // failure into a `self-blocked` exit (task settles as blocked, run continues); only
          // a fatal `Aborted`/`RateLimit` propagates and aborts the run.
          const validated = await validateSignalsFile(outputDir, generatorOutputContract);
          if (!validated.ok) return Result.error(validated.error);
          const signals = validated.value;

          // Fan out to BOTH the legacy `HarnessSignalSink` (TUI panels, decisions-log) and
          // the application bus's typed `ai-signal` event. The bus carries every kind the
          // contract accepts; the sink keeps its existing per-kind consumers happy until
          // Wave 6 collapses the two paths.
          for (const sig of signals) {
            deps.signals.emit(sig);
            deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'generator' });
            if (sig.type === 'decision') decisionsEmitted.push(sig.text);
            else if (sig.type === 'change') changesEmitted.push(sig.text);
            else if (sig.type === 'learning')
              learningsEmitted.push({
                text: sig.text,
                ...(sig.context !== undefined ? { context: sig.context } : {}),
                ...(sig.appliesTo !== undefined ? { appliesTo: sig.appliesTo } : {}),
              });
            else if (sig.type === 'note') notesEmitted.push(sig.text);
          }

          // Render harness-owned sidecars (`commit-message.txt` when present). Write
          // failures log warn inside `renderSidecars`; the helper always returns
          // `Result.ok` (sidecars are operator UX only — downstream leaves read in-memory
          // signals from ctx, never the sidecar file).
          await renderSidecars(deps.writeFile, outputDir, signals, generatorOutputContract.sidecars, deps.logger);

          // `runGeneratorTurnUseCase` expects `readonly HarnessSignal[]`. `GeneratorContractSignal`
          // is a strict subset of `HarnessSignal`, but TS's array variance doesn't infer
          // that automatically — cast through `AiSignal[]` (the canonical union alias) to
          // keep the call site honest about the underlying domain shape.
          return Result.ok(signals as readonly AiSignal[]) as Result<readonly HarnessSignal[], DomainError>;
        };

        const result = await runGeneratorTurnUseCase({
          task: input.task,
          callImplement,
          logger: deps.logger,
        });
        if (!result.ok) return Result.error(result.error);

        // Read THIS turn's captured sessionId from disk (the Claude adapter just wrote it as a
        // sibling of `signals.json` via `persistSessionIdFile`). Undefined when the spawn never
        // reported an id — left undefined so the next round cold-starts cleanly rather than
        // forwarding a stale id from a prior task.
        const capturedSessionId = await readRoundSessionId(input.workspaceRoot, roundNum, 'generator');

        return Result.ok({
          task: result.value.task,
          turn: input.turn,
          roundNum,
          decisionsEmitted,
          changesEmitted,
          learningsEmitted,
          notesEmitted,
          ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
          ...(result.value.proposedCommitMessage !== undefined
            ? { proposedCommitMessage: result.value.proposedCommitMessage }
            : {}),
          ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
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
      if (ctx.taskWorkspaceRoot === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generator',
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.taskWorkspaceRoot missing — buildTaskWorkspaceLeaf must run first`,
        });
      }
      if (ctx.currentRoundNum === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-generator',
          attemptedAction: `generator-${String(taskId)}`,
          message: `generator-${String(taskId)}: ctx.currentRoundNum missing — resolve-round-num must run first`,
        });
      }
      return {
        task: ctx.currentTask,
        turn: (ctx.genEvalTurn ?? 0) + 1,
        workspaceRoot: ctx.taskWorkspaceRoot,
        roundNum: ctx.currentRoundNum,
        ...(ctx.priorGeneratorSessionId !== undefined ? { priorGeneratorSessionId: ctx.priorGeneratorSessionId } : {}),
      };
    },
    output: (ctx, out) => {
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
      // Latest non-undefined proposed commit message wins across turns.
      const proposedCommitMessage = out.proposedCommitMessage ?? ctx.proposedCommitMessage;
      const carry = proposedCommitMessage !== undefined ? { proposedCommitMessage } : {};
      // Latest captured generator sessionId wins; only OVERWRITE when this turn produced one.
      // A turn that failed to capture an id (provider crash mid-stream) preserves whatever the
      // prior turn captured so the next round still has a thread to resume.
      const sessionCarry =
        out.capturedSessionId !== undefined ? { priorGeneratorSessionId: out.capturedSessionId } : {};
      // Accumulate this turn's signal texts onto the per-attempt aggregates. Cleared by the
      // progress-journal leaf after the attempt settles. Each kind has its own field on ctx so
      // the journal renderer can drop empty subsections without inspecting the signal type.
      const decisionsCarry =
        out.decisionsEmitted.length > 0
          ? { currentAttemptDecisions: [...(ctx.currentAttemptDecisions ?? []), ...out.decisionsEmitted] }
          : {};
      const changesCarry =
        out.changesEmitted.length > 0
          ? { currentAttemptChanges: [...(ctx.currentAttemptChanges ?? []), ...out.changesEmitted] }
          : {};
      const learningsCarry =
        out.learningsEmitted.length > 0
          ? { currentAttemptLearnings: [...(ctx.currentAttemptLearnings ?? []), ...out.learningsEmitted] }
          : {};
      const notesCarry =
        out.notesEmitted.length > 0
          ? { currentAttemptNotes: [...(ctx.currentAttemptNotes ?? []), ...out.notesEmitted] }
          : {};
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
          ...sessionCarry,
          ...decisionsCarry,
          ...changesCarry,
          ...learningsCarry,
          ...notesCarry,
        };
      }
      return {
        ...ctx,
        currentTask: out.task,
        tasks,
        genEvalTurn: out.turn,
        currentRoundNum: out.roundNum,
        ...carry,
        ...sessionCarry,
        ...decisionsCarry,
        ...changesCarry,
        ...learningsCarry,
        ...notesCarry,
      };
    },
  });
