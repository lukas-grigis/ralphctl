import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import {
  type EvaluatorTurnExit,
  type RunEvaluatorTurnProps,
  runEvaluatorTurnUseCase,
} from '@src/business/task/run-evaluator-turn.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSignal, EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildEvaluatePrompt } from '@src/integration/ai/prompts/evaluate/definition.ts';
import { buildEvaluateContinuationPrompt } from '@src/integration/ai/prompts/evaluate-continuation/definition.ts';
import type { BuildPromptError } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { computeWorkProductFingerprint } from '@src/application/flows/implement/leaves/work-product-fingerprint.ts';
import { evaluatorOutputContract } from '@src/application/flows/implement/leaves/evaluator.contract.ts';
import {
  readRoundSessionId,
  roundEvaluationRelativePath,
} from '@src/application/flows/implement/leaves/round-artifacts.ts';
import {
  composeGeneratorHints,
  type GeneratorHintsInput,
} from '@src/application/flows/implement/leaves/_shared/generator-hints.ts';
import { positiveCountCarry } from '@src/application/flows/implement/leaves/_shared/nudge-count-carry.ts';
import {
  buildEvaluatorReproductionSection,
  type ReproductionArtifact,
} from '@src/application/flows/implement/leaves/reproduce.ts';
import {
  readCappedProgress,
  requireRoleTurnCtx,
  resolveProjectToolingCarry,
  resolveRoundPaths,
  type RoleLeafDeps,
  runRoleTurn,
  selfContainedGrounding,
} from '@src/application/flows/implement/leaves/_shared/run-role-turn.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';

/**
 * Chain leaf — one evaluator turn of the gen-eval loop. Wires the integration ports
 * (`provider`, `templateLoader`, `publishSignal`, `writeFile`) into function-shape
 * deps for {@link runEvaluatorTurnUseCase}; the use case owns the per-turn business decisions
 * (evaluation recording, plateau detection, malformed detection, critique recording).
 *
 * File-based contract (audit-[09]): the leaf reuses the generator's `ctx.currentRoundNum` so
 * generator and evaluator artifacts share the round folder. `session.signalsFile =
 * <workspaceRoot>/rounds/<N>/evaluator/signals.json` is set on the provider call; after the
 * call the leaf {@link validateSignalsFile validates} the file against
 * {@link evaluatorOutputContract}, publishes every validated signal onto the application bus as
 * a typed `ai-signal` event (the one harness-signal channel), then renders the harness-owned
 * `evaluation.md` sidecar via {@link renderSidecars}. The leaf no longer constructs
 * `evaluation.md` directly — sidecar rendering is the only writer.
 *
 * The leaf reads `ctx.plateauHistory` (default `[]`) as `priorTurns` for plateau comparison,
 * appends the new turn record on completion, and writes the new evaluation back to
 * `ctx.lastEvaluation`. `ctx.proposedCommitMessage.subject` (the generator's same-round
 * `commit-message` signal) flows in as `currentCommitSubject`. When the use case returns a
 * terminal `exit`, the leaf writes the matching ctx fields so the surrounding `loop`'s
 * `shouldStop` predicate exits cleanly.
 */
export interface EvaluatorLeafDeps extends RoleLeafDeps {
  /**
   * Git transport — used post-spawn to compute the round's work-product fingerprint (a content
   * hash of `git status --porcelain` + `git diff HEAD` against the repo working tree). Fed into
   * the plateau predicate so its progress exemption measures real code change, not commit-message
   * rewording. Threaded down from `ImplementDeps.gitRunner`.
   */
  readonly gitRunner: GitRunner;
}

interface EvaluatorInput {
  readonly task: InProgressTask;
  readonly priorTurns: readonly PlateauTurnRecord[];
  readonly currentCommitSubject?: string;
  /**
   * Pre-composed same-round generator observations (T5) — proposed commit subject, change /
   * learning / note accumulators from `ImplementCtx`, framed downstream as unverified environment
   * context. Composed in the `input` projection (pure ctx read) and rendered inside the
   * `<generator_hints>` block. Empty string when no generator hints were accumulated this attempt.
   */
  readonly generatorHints: string;
  readonly workspaceRoot: AbsolutePath;
  readonly roundNum: number;
  /**
   * Captured Claude `session_id` from the prior round's evaluator turn for this task. Forwarded
   * to `implementSession({ resume })` so the reviewer continues a single conversational thread
   * across rounds. `undefined` on round 1 (or when the prior spawn failed before reporting an
   * id) → fresh session.
   */
  readonly priorEvaluatorSessionId?: SessionId;
  /**
   * The validated reproduction artifact (read side) — the SAME `ctx.reproductionArtifact` the
   * guarded `reproduce-<taskId>` leaf validated before the attempt loop. Rendered into the
   * `<reproduction>` prompt body (with a re-checksum tamper check — see
   * `buildEvaluatorReproductionSection` in `reproduce.ts`) inside {@link makeEvaluatorCallEvaluate},
   * which is async and has `deps.cwd`; this `input` projection stays a pure ctx read, so the raw
   * artifact rides here rather than a pre-rendered string. Rides every round (not just round 1) —
   * the evaluator's re-run instruction is an extension of its verification-tampering check on
   * every turn. Undefined when the task is not defect-shaped or no reproduction was validated.
   */
  readonly reproductionArtifact?: ReproductionArtifact;
}

interface EvaluatorOutput {
  readonly task: InProgressTask;
  readonly evaluation?: EvaluationSignal;
  readonly exit?: EvaluatorTurnExit;
  readonly turnRecord?: PlateauTurnRecord;
  /**
   * `session_id` captured by the Claude adapter for THIS turn — read from
   * `rounds/<N>/evaluator/session-id.txt` after the spawn returns. Stamped onto ctx by the output
   * projection so the next round's evaluator can resume the same thread.
   */
  readonly capturedSessionId?: SessionId;
  /**
   * Corrective `signals.json` nudges this turn needed (`0` on a clean first parse) — read from
   * `validateSignalsFileWithCorrectiveRetry`'s `nudgeCount`. Accumulates onto
   * `ctx.currentAttemptEvaluatorNudges` so the journal leaf can render the cost-visibility
   * clause. Pure observability; never affects retry semantics.
   */
  readonly correctiveNudgeCount: number;
}

/**
 * Per-turn out-channel for the corrective-nudge tally — mutated in place after
 * `validateSignalsFileWithCorrectiveRetry` resolves. Mirrors the generator leaf's
 * `GeneratorTurnAccumulators`: `callEvaluate` is bound to the business use case's fixed
 * `Result<readonly HarnessSignal[], DomainError>>` signature, so the count rides out via this
 * closure-captured mutable object instead of widening that return type.
 */
interface EvaluatorTurnMeta {
  correctiveNudgeCount: number;
}

/**
 * Select and build this turn's evaluator prompt by session continuity. Mirrors the generator
 * leaf's {@link import('./generator.ts')} helper.
 *
 * The FIRST evaluator turn of a session thread (`priorEvaluatorSessionId === undefined`) re-sends
 * the full specification + rubric; a RESUMED turn sends the slim continuation prompt because the
 * conversation already holds them, so only the per-round delta (round number, recent journal)
 * need ride. `start-attempt` clears the session slot per attempt, so attempt boundaries always
 * re-send the full context. A provider that never reports a session id keeps getting the full
 * prompt automatically — the discriminant is the same field `--resume` consumes.
 */

const buildEvaluatorPrompt = async (
  deps: EvaluatorLeafDeps,
  args: {
    readonly task: InProgressTask;
    readonly workspaceRoot: AbsolutePath;
    readonly roundNum: number;
    readonly outputContractSection: string;
    readonly priorEvaluatorSessionId: SessionId | undefined;
    /**
     * Pre-composed `<generator_hints>` body (T5). Threaded into the builder's `generatorHints`
     * slot only when non-empty so the placeholder collapses cleanly otherwise.
     */
    readonly generatorHints: string;
    /** Pre-composed reproduction body — see `EvaluatorInput.reproduction`'s docstring. */
    readonly reproduction: string | undefined;
  }
): Promise<Result<Prompt, BuildPromptError>> => {
  const sharedValues = {
    contractPath: join(String(args.workspaceRoot), 'contract.md'),
    priorProgress: await readCappedProgress(String(deps.progressFile), String(args.task.id), deps.model),
    outputContractSection: args.outputContractSection,
    // Threaded only when non-empty so the `<generator_hints>` placeholder collapses cleanly.
    ...(args.generatorHints.length > 0 ? { generatorHints: args.generatorHints } : {}),
    ...(args.reproduction !== undefined ? { reproduction: args.reproduction } : {}),
  };

  if (args.priorEvaluatorSessionId !== undefined) {
    return buildEvaluateContinuationPrompt(deps.templateLoader, {
      ...sharedValues,
      roundNumber: args.roundNum,
      progressFile: String(deps.progressFile),
    });
  }
  return buildEvaluatePrompt(deps.templateLoader, {
    ...sharedValues,
    task: args.task,
    projectPath: String(deps.cwd),
    ...(deps.verifyScript !== undefined ? { verifyScript: deps.verifyScript } : {}),
    ...(await resolveProjectToolingCarry(deps)),
    // The agent-definition section rides ONLY the full prompt — a resumed continuation already
    // carries it in-conversation.
    ...(deps.agentDefinition !== undefined ? { agentDefinition: deps.agentDefinition } : {}),
  });
};

/**
 * The reviewer's own grounding lines for a COLD corrective spawn — without them a context-free
 * retry's whole prompt is the error text, which is exactly enough scaffolding to fabricate a
 * schema-valid verdict for work the reviewer never saw.
 */
const EVALUATOR_GROUNDING = [
  'Your PRIMARY INPUT is the uncommitted working-tree diff — inspect it via shell',
  '(`git status` / `git diff HEAD`) before grading. A verdict must reflect the actual',
  'work, never this message.',
] as const;

/**
 * Build this turn's `callEvaluate` — selects + builds the prompt, then hands the rest of the turn
 * to {@link runRoleTurn} (persist prompt, spawn, validate with bounded corrective nudges, render
 * the `evaluation.md` sidecar). Returns the parsed signals for `runEvaluatorTurnUseCase` to
 * interpret.
 */
const makeEvaluatorCallEvaluate =
  (
    deps: EvaluatorLeafDeps,
    args: {
      readonly input: EvaluatorInput;
      readonly signalsFile: AbsolutePath;
      readonly outputDir: AbsolutePath;
      readonly signal: AbortSignal | undefined;
      readonly meta: EvaluatorTurnMeta;
    }
  ): RunEvaluatorTurnProps['callEvaluate'] =>
  async (task) => {
    const outputContractSection = renderContractSectionFor(evaluatorOutputContract, args.outputDir);

    const turn = await runRoleTurn(deps, {
      role: 'evaluator',
      workspaceRoot: args.input.workspaceRoot,
      roundNum: args.input.roundNum,
      signalsFile: args.signalsFile,
      outputDir: args.outputDir,
      // The evaluator MODEL is never escalated — it always stays the configured row, on both the
      // initial spawn and every corrective respawn.
      model: deps.model,
      // Per-task evaluator-EFFORT escalation: the escalation policy's lockstep bump stamps
      // `escalatedToEvaluatorEffort` (computed against the evaluator's own ladder, never copied
      // from the generator's target) when it fires alongside the generator's same-model effort
      // rung. Prefer it over the configured `deps.effort` at spawn.
      effort: task.escalatedToEvaluatorEffort ?? deps.effort,
      priorSessionId: args.input.priorEvaluatorSessionId,
      signal: args.signal,
      contract: evaluatorOutputContract,
      buildPrompt: async () => {
        // Re-checksum the reproduction test against the hash captured when it was validated —
        // an unexplained edit (or deletion) during the gen-eval loop appends a bounded tampering
        // note to the SAME `<reproduction>` section the template's tampering-detection rule
        // already audits. Only the evaluator re-checks (once per turn); `generator.ts` keeps the
        // plain, sync `readReproductionSection` — see `EvaluatorInput.reproductionArtifact`.
        const reproduction =
          args.input.reproductionArtifact !== undefined
            ? await buildEvaluatorReproductionSection(deps.cwd, args.input.reproductionArtifact)
            : undefined;
        return buildEvaluatorPrompt(deps, {
          task,
          workspaceRoot: args.input.workspaceRoot,
          roundNum: args.input.roundNum,
          outputContractSection,
          priorEvaluatorSessionId: args.input.priorEvaluatorSessionId,
          generatorHints: args.input.generatorHints,
          reproduction,
        });
      },
      selfContainedContext: selfContainedGrounding(
        args.input.workspaceRoot,
        outputContractSection,
        EVALUATOR_GROUNDING
      ),
      // Publish every validated signal onto the one harness-signal channel.
      onSignals: (signals) => {
        for (const sig of signals) deps.publishSignal(sig);
      },
    });
    if (!turn.ok) return Result.error(turn.error) as Result<readonly HarnessSignal[], DomainError>;
    // Cost-visibility out-channel — see EvaluatorTurnMeta's docstring for why this rides a
    // mutated field rather than widening `callEvaluate`'s return type.
    args.meta.correctiveNudgeCount = turn.value.nudgeCount;

    // `runEvaluatorTurnUseCase` expects `readonly HarnessSignal[]`. `EvaluatorContractSignal`
    // is a strict subset of `HarnessSignal`, but TS's array variance doesn't infer that
    // automatically — cast through `AiSignal[]` (the canonical union alias) to keep the
    // call site honest about the underlying domain shape.
    return Result.ok(turn.value.signals as readonly AiSignal[]) as Result<readonly HarnessSignal[], DomainError>;
  };

/**
 * Build this leaf's `execute` — resolves the round's `signals.json` path, fingerprints the
 * working tree's uncommitted changes for the plateau predicate's progress exemption, drives one
 * evaluator turn via `runEvaluatorTurnUseCase` (see {@link makeEvaluatorCallEvaluate}), then reads
 * back the captured session id into {@link EvaluatorOutput}.
 */
const makeEvaluatorExecute =
  (
    deps: EvaluatorLeafDeps
  ): ((input: EvaluatorInput, signal?: AbortSignal) => Promise<Result<EvaluatorOutput, DomainError>>) =>
  async (input, signal) => {
    const paths = resolveRoundPaths(input.workspaceRoot, input.roundNum, 'evaluator');
    if (!paths.ok) return Result.error(paths.error);

    // Cost-visibility out-channel for this turn's corrective-nudge tally — closure-captured so
    // `execute` can stamp it onto `EvaluatorOutput` after the use case returns.
    const meta: EvaluatorTurnMeta = { correctiveNudgeCount: 0 };
    const callEvaluate = makeEvaluatorCallEvaluate(deps, { input, ...paths.value, signal, meta });

    // Fingerprint the working tree's uncommitted changes for this round so the plateau
    // predicate's progress exemption measures real code change instead of commit-message
    // rewording. Best-effort — a git failure yields `undefined` and the predicate degrades
    // to the commit-subject proxy. Computed BEFORE the use case so the record carries it.
    const changedFilesHash = await computeWorkProductFingerprint(deps.gitRunner, deps.cwd);

    const result = await runEvaluatorTurnUseCase({
      task: input.task,
      priorTurns: input.priorTurns,
      plateauThreshold: deps.plateauThreshold,
      ...(input.currentCommitSubject !== undefined ? { currentCommitSubject: input.currentCommitSubject } : {}),
      ...(changedFilesHash !== undefined ? { changedFilesHash } : {}),
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
      correctiveNudgeCount: meta.correctiveNudgeCount,
      ...(result.value.evaluation !== undefined ? { evaluation: result.value.evaluation } : {}),
      ...(result.value.exit !== undefined ? { exit: result.value.exit } : {}),
      ...(result.value.turnRecord !== undefined ? { turnRecord: result.value.turnRecord } : {}),
      ...(capturedSessionId !== undefined ? { capturedSessionId } : {}),
    });
  };

/**
 * Build this leaf's `input` projection — validates the ctx preconditions the evaluator turn needs
 * (`currentTask`, `taskWorkspaceRoot`, `currentRoundNum`), then composes the same-round
 * `<generator_hints>` block (T5) from pure ctx reads before assembling {@link EvaluatorInput}.
 */
const makeEvaluatorInput =
  (taskId: TaskId): ((ctx: ImplementCtx) => EvaluatorInput) =>
  (ctx) => {
    const { task, workspaceRoot, roundNum } = requireRoleTurnCtx(ctx, 'evaluator', taskId);
    const currentCommitSubject = ctx.proposedCommitMessage?.subject;
    // T5: compose the same-round generator hints from the per-attempt ctx accumulators. Pure
    // read — `composeGeneratorHints` caps + clamps so a deep multi-round attempt's accumulators
    // can't balloon the evaluator prompt. Empty across all sources → '' → placeholder collapses.
    const hintsInput: GeneratorHintsInput = {
      ...(currentCommitSubject !== undefined ? { commitSubject: currentCommitSubject } : {}),
      ...(ctx.currentAttemptChanges !== undefined ? { changes: ctx.currentAttemptChanges } : {}),
      ...(ctx.currentAttemptLearnings !== undefined ? { learnings: ctx.currentAttemptLearnings } : {}),
      ...(ctx.currentAttemptNotes !== undefined ? { notes: ctx.currentAttemptNotes } : {}),
    };
    // Reproduction-first (read side) — the raw artifact rides here; the async re-checksum + render
    // happens in `makeEvaluatorCallEvaluate` (see `EvaluatorInput.reproductionArtifact`'s docstring).
    return {
      task,
      priorTurns: ctx.plateauHistory ?? [],
      workspaceRoot,
      roundNum,
      generatorHints: composeGeneratorHints(hintsInput),
      ...(currentCommitSubject !== undefined ? { currentCommitSubject } : {}),
      ...(ctx.priorEvaluatorSessionId !== undefined ? { priorEvaluatorSessionId: ctx.priorEvaluatorSessionId } : {}),
      ...(ctx.reproductionArtifact !== undefined ? { reproductionArtifact: ctx.reproductionArtifact } : {}),
    };
  };

/**
 * Merge one evaluator turn's output into ctx — task/tasks list, plateau history, captured
 * session id, and the verdict / terminal-exit fields.
 */
const evaluatorOutput = (ctx: ImplementCtx, out: EvaluatorOutput): ImplementCtx => {
  const tasks = (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? out.task : t));
  const nextHistory =
    out.turnRecord !== undefined ? [...(ctx.plateauHistory ?? []), out.turnRecord] : ctx.plateauHistory;
  // Latest captured evaluator sessionId wins; only OVERWRITE when this turn produced one
  // (preserves the prior turn's thread when this spawn failed to report an id).
  const sessionCarry = out.capturedSessionId !== undefined ? { priorEvaluatorSessionId: out.capturedSessionId } : {};
  // Cost-visibility tally — accumulates across every turn of the attempt, same lifecycle as the
  // generator leaf's mirror field. Zero-noise: a turn with no nudge contributes nothing.
  const evaluatorNudgesCarry = positiveCountCarry(
    'currentAttemptEvaluatorNudges',
    out.correctiveNudgeCount,
    ctx.currentAttemptEvaluatorNudges
  );
  const next: ImplementCtx = {
    ...ctx,
    currentTask: out.task,
    tasks,
    // Direct assignment (NOT a conditional spread): a self-blocked / signals-missing turn
    // returns `out.evaluation === undefined`, and we must CLEAR `ctx.lastEvaluation` so
    // `settle-attempt` never writes the prior round's verdict into this round's `outcome.md`.
    // `ctx.ts` types `lastEvaluation?` so assigning `undefined` is valid + explicit.
    lastEvaluation: out.evaluation,
    ...(nextHistory !== undefined ? { plateauHistory: nextHistory } : {}),
    ...sessionCarry,
    ...evaluatorNudgesCarry,
  };
  if (out.exit === undefined) return next;
  return { ...next, lastExit: out.exit };
};

export const evaluatorLeaf = (deps: EvaluatorLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, EvaluatorInput, EvaluatorOutput>(`evaluator-${String(taskId)}`, {
    useCase: { execute: makeEvaluatorExecute(deps) },
    input: makeEvaluatorInput(taskId),
    output: evaluatorOutput,
  });
