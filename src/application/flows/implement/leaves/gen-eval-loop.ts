import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { detectRepetitiveLoop } from '@src/business/task/escalation-policy.ts';
import { failedDimensions } from '@src/business/task/plateau-detection.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';
import { resolveRoundNumLeaf } from '@src/application/flows/implement/leaves/resolve-round-num.ts';
import {
  stampEvaluatorRoleMetaLeaf,
  stampGeneratorRoleMetaLeaf,
} from '@src/application/flows/implement/leaves/stamp-role-meta.ts';
import {
  stampImplementEvaluatorSessionMetaLeaf,
  stampImplementGeneratorSessionMetaLeaf,
} from '@src/application/flows/implement/leaves/stamp-implement-session-meta.ts';

/**
 * Per-turn gen-eval composite element — the `loop` body for one task. Iterates
 * `generator-leaf → evaluator-leaf` until a terminal exit lands on ctx (`lastExit !== undefined`)
 * or the configured `maxTurns` budget is hit.
 *
 * Each turn opens with `resolve-round-num` which claims the next `rounds/<N>/` on disk and stamps
 * `ctx.currentRoundNum`. Two attribution sidecars then fire before each spawn:
 *   - `stamp-meta-<role>` writes the generic `rounds/<N>/<role>/meta.json` (the same shape every
 *     AI flow stamps beside its `signals.json`).
 *   - `stamp-role-meta-<role>` writes the implement-specific
 *     `rounds/<N>/<role>/role-meta.json`, which carries the attempt / escalation context the
 *     generic shape doesn't (`role`, `attemptN`, `escalatedFromModel`).
 *
 * Both sidecars land BEFORE the spawn so attribution survives a mid-spawn crash (signals.json
 * may be absent post-failure; the meta files name the provider regardless).
 *
 * The evaluator step is guarded — if the generator self-blocked this turn it set `lastExit` and
 * the evaluator must not run.
 */

export interface GenEvalLoopDeps {
  readonly generatorProvider: HeadlessAiProvider;
  readonly evaluatorProvider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly writeFile: WriteFile;
  /**
   * Git transport — threaded into the evaluator leaf so it can fingerprint the working tree's
   * uncommitted changes each round for the plateau predicate's work-product exemption.
   */
  readonly gitRunner: GitRunner;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  /** Per-spawn config — read via `readConfig()` for the loop's `shouldContinue` predicate. */
  readonly readConfig: () => Promise<{ readonly maxTurns: number }>;
  readonly maxTurns: number;
  readonly plateauThreshold: number;
}

export interface GenEvalLoopRoleConfig {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
}

export interface GenEvalLoopOpts {
  readonly cwd: AbsolutePath;
  readonly sprintDir: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly verifyScript?: string;
  readonly generator: GenEvalLoopRoleConfig;
  readonly evaluator: GenEvalLoopRoleConfig;
}

export const createGenEvalLoop = (
  deps: GenEvalLoopDeps,
  opts: GenEvalLoopOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  // Shared cross-role fields — every gen-eval leaf reads the same ports, cwd, sprint paths, and
  // harness-config-derived budgets. The per-role provider + model + effort triple is overlaid on
  // top below so generator / evaluator can target different providers.
  const sharedLeafDeps = {
    templateLoader: deps.templateLoader,
    signals: deps.signals,
    // Threaded into both gen-eval leaves so harness-owned sidecars (audit-[09]
    // `commit-message.txt` for the generator, `evaluation.md` for the evaluator) land via
    // the atomic-write port. The leaves never write these files directly.
    writeFile: deps.writeFile,
    cwd: opts.cwd,
    // Threaded into `implementSession()` as a second `--add-dir` so the AI can read
    // sprint-wide artifacts (`progress.md`) that live outside the per-task sandbox.
    sprintDir: opts.sprintDir,
    progressFile: opts.progressFile,
    clock: deps.clock,
    logger: deps.logger,
    eventBus: deps.eventBus,
    maxTurns: deps.maxTurns,
    plateauThreshold: deps.plateauThreshold,
    ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
  };
  const generatorLeafDeps = {
    ...sharedLeafDeps,
    provider: deps.generatorProvider,
    model: opts.generator.model,
    ...(opts.generator.effort !== undefined ? { effort: opts.generator.effort } : {}),
  };
  const evaluatorLeafDeps = {
    ...sharedLeafDeps,
    // Evaluator-only: the work-product fingerprint for the plateau predicate. The generator
    // leaf neither needs nor accepts the git runner.
    gitRunner: deps.gitRunner,
    provider: deps.evaluatorProvider,
    model: opts.evaluator.model,
    ...(opts.evaluator.effort !== undefined ? { effort: opts.evaluator.effort } : {}),
  };

  // ---------------------------------------------------------------------------
  // Loop-diversity guard (TIDE arXiv 2602.02196)
  //
  // Tracks a rolling fingerprint of each evaluator turn's failed-dimension set.
  // When the last DIVERSITY_WINDOW_SIZE fingerprints are all identical the loop is
  // repeating the same approach without progress — exit via a plateau exit so the
  // escalation policy can climb the model ladder or apply a change-of-approach nudge.
  //
  // State is closure-scoped to this element instance; `lastAttemptCount` resets the
  // history at each new attempt boundary so fingerprints don't leak across attempts.
  // ---------------------------------------------------------------------------
  const DIVERSITY_WINDOW_SIZE = 3;
  let lastAttemptCount = -1;
  const diversityHistory: string[] = [];

  interface DiversityCheckInput {
    readonly latestRecord: PlateauTurnRecord | undefined;
    readonly alreadyExiting: boolean;
    readonly attemptCount: number;
    /** Turn just completed (`ctx.genEvalTurn`) — compared against the budget so the guard never pre-empts the final turn. */
    readonly turnsUsed: number;
  }

  interface DiversityCheckOutput {
    readonly shouldExit: boolean;
    readonly dimensions?: readonly string[];
  }

  const loopDiversityCheckLeaf = leaf<ImplementCtx, DiversityCheckInput, DiversityCheckOutput>(
    `loop-diversity-check-${String(taskId)}`,
    {
      useCase: {
        execute: async (input) => {
          // Reset per attempt so history from a prior attempt doesn't carry over.
          if (input.attemptCount !== lastAttemptCount) {
            lastAttemptCount = input.attemptCount;
            diversityHistory.length = 0;
          }

          // Skip when the evaluator already set a terminal exit this turn, or when the
          // evaluator did not run (generator self-blocked — latestRecord is undefined).
          if (input.alreadyExiting || input.latestRecord === undefined) {
            return Result.ok({ shouldExit: false });
          }

          // Fingerprint = sorted set of currently-failed dimension names joined by '|'.
          // A passing evaluation (all dimensions green) has no failed dimensions → no
          // fingerprint → no diversity record (the loop would exit via 'passed' anyway).
          const failed = failedDimensions(input.latestRecord.evaluation);
          if (failed.size === 0) return Result.ok({ shouldExit: false });

          const fingerprint = [...failed].sort().join('|');
          diversityHistory.push(fingerprint);
          if (diversityHistory.length > DIVERSITY_WINDOW_SIZE * 2) {
            diversityHistory.splice(0, diversityHistory.length - DIVERSITY_WINDOW_SIZE * 2);
          }

          if (!detectRepetitiveLoop(diversityHistory, DIVERSITY_WINDOW_SIZE)) {
            return Result.ok({ shouldExit: false });
          }

          // Budget exhaustion takes precedence. When this was the final turn the loop would run
          // anyway (turnsUsed === budget), there is no remaining budget for an early escalation
          // to reclaim — the truthful terminal state is `budget-exhausted`, so let `finalize`
          // synthesise it instead of pre-empting it with a `plateau`. This preserves the
          // invariant that a run where every turn fails from the very start (never any progress)
          // always exits as `budget-exhausted`. Read the same `readConfig` budget the loop's
          // `shouldContinue` uses so a runtime config change can't diverge the two.
          const { maxTurns } = await deps.readConfig();
          if (input.turnsUsed >= Math.max(1, maxTurns)) {
            return Result.ok({ shouldExit: false });
          }

          // Diversity collapsed — the generator has repeated the exact same failure pattern
          // for the last DIVERSITY_WINDOW_SIZE turns without any approach change. Surface a
          // warn banner and exit the loop so the escalation ladder can intervene.
          deps.eventBus.publish({
            type: 'banner-show',
            id: `loop-diversity-${String(taskId)}`,
            tier: 'warn',
            message: 'Generator is repeating the same approach — escalating',
            cause: 'loop-diversity-exhausted',
            at: deps.clock(),
          });

          return Result.ok({ shouldExit: true, dimensions: [...failed] });
        },
      },
      input: (ctx) => {
        const history = ctx.plateauHistory;
        const latestRecord = history !== undefined && history.length > 0 ? history[history.length - 1] : undefined;
        return {
          latestRecord,
          alreadyExiting: ctx.lastExit !== undefined,
          attemptCount: ctx.currentTask?.attempts.length ?? 0,
          turnsUsed: ctx.genEvalTurn ?? 0,
        };
      },
      output: (ctx, out) => {
        if (!out.shouldExit || out.dimensions === undefined) return ctx;
        return { ...ctx, lastExit: { kind: 'plateau', dimensions: out.dimensions } };
      },
    }
  );

  return loop<ImplementCtx>(
    `gen-eval-${String(taskId)}`,
    sequential<ImplementCtx>(`gen-eval-turn-${String(taskId)}`, [
      resolveRoundNumLeaf(taskId),
      stampImplementGeneratorSessionMetaLeaf(
        { writeFile: deps.writeFile, clock: deps.clock },
        {
          providerId: opts.generator.providerId,
          model: opts.generator.model,
          ...(opts.generator.effort !== undefined ? { effort: opts.generator.effort } : {}),
        },
        taskId
      ),
      stampGeneratorRoleMetaLeaf(
        { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
        {
          provider: opts.generator.providerId,
          model: opts.generator.model,
          ...(opts.generator.effort !== undefined ? { effort: opts.generator.effort } : {}),
        },
        taskId
      ),
      generatorLeaf(generatorLeafDeps, taskId),
      guard<ImplementCtx>(
        `evaluator-guard-${String(taskId)}`,
        (ctx) => ctx.lastExit === undefined,
        sequential<ImplementCtx>(`evaluator-step-${String(taskId)}`, [
          stampImplementEvaluatorSessionMetaLeaf(
            { writeFile: deps.writeFile, clock: deps.clock },
            {
              providerId: opts.evaluator.providerId,
              model: opts.evaluator.model,
              ...(opts.evaluator.effort !== undefined ? { effort: opts.evaluator.effort } : {}),
            },
            taskId
          ),
          stampEvaluatorRoleMetaLeaf(
            { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
            {
              provider: opts.evaluator.providerId,
              model: opts.evaluator.model,
              ...(opts.evaluator.effort !== undefined ? { effort: opts.evaluator.effort } : {}),
            },
            taskId
          ),
          evaluatorLeaf(evaluatorLeafDeps, taskId),
          loopDiversityCheckLeaf,
        ])
      ),
    ]),
    {
      // Loop-entry guard. Refuse to enter a turn when a terminal exit is ALREADY on ctx — the
      // only way `lastExit` is set at loop entry is a pre-task-verify block/skip (start-attempt
      // runs before pre-verify and settle-attempt clears `lastExit` at the end of every attempt,
      // so no stale exit can leak across attempts/tasks; the parallel merge-wave classifies
      // `lastExit` PER_TASK). Without this check a pre-blocked task would still claim a
      // `rounds/<N>/` dir, stamp two meta sidecars, and spawn one full generator session on the
      // exact broken tree the gate refused — the most expensive unit in the system.
      shouldContinue: async (ctx, i) => {
        const cfg = await deps.readConfig();
        return ctx.lastExit === undefined && i <= Math.max(1, cfg.maxTurns);
      },
      shouldStop: (ctx) => ctx.lastExit !== undefined,
    }
  );
};
