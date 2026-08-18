import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
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
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { entropyCheckLeaf } from '@src/application/flows/implement/leaves/entropy-check.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';
import { loopDiversityCheckLeaf } from '@src/application/flows/implement/leaves/loop-diversity-check.ts';
import { resolveRoundNumLeaf } from '@src/application/flows/implement/leaves/resolve-round-num.ts';
import {
  stampEvaluatorRoleMetaLeaf,
  stampGeneratorRoleMetaLeaf,
} from '@src/application/flows/implement/leaves/stamp-role-meta.ts';
import {
  stampImplementEvaluatorSessionMetaLeaf,
  stampImplementGeneratorSessionMetaLeaf,
} from '@src/application/flows/implement/leaves/stamp-implement-session-meta.ts';
import {
  type GenEvalLoopRoleConfig,
  roleSpawnConfig,
  withRoleSpawn,
} from '@src/application/flows/implement/leaves/_shared/role-spawn.ts';

// Re-exported so every existing importer of `GenEvalLoopRoleConfig` (attempt-body.ts,
// per-task-subchain.ts, best-of-n-record.ts, _shared/run-role-turn.ts, tests) keeps working
// unchanged — the canonical definition now lives in `_shared/role-spawn.ts`, the one place
// `best-of-n.ts`'s composite and this loop both read it from.
export type { GenEvalLoopRoleConfig } from '@src/application/flows/implement/leaves/_shared/role-spawn.ts';

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
  /**
   * Fan-out seam for every validated signal either role's turn emits — the ONE harness-signal
   * channel (see `publish-signal.ts`). Shared verbatim by both the generator and evaluator leaf
   * (both roles publish under the SAME pre-bound source/taskId; the leaf itself no longer picks
   * its own source string).
   */
  readonly publishSignal: PublishSignal;
  readonly writeFile: WriteFile;
  /**
   * Per-flow skill catalog port — threaded into both gen-eval leaves so the FULL prompt's
   * `{{PROJECT_TOOLING}}` catalog can name this task's installed skills (the same source
   * `installSkillsLeaf` already reads). Optional so a caller that doesn't care about tooling
   * naming (most tests) can omit it.
   */
  readonly skillSource?: SkillSource;
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
  /** Bounded corrective in-round nudges before a signals.json contract failure self-blocks (1–5). */
  readonly correctiveRetries: number;
  /**
   * `settings.harness.entropyPlateauDetector` — opt-in (default off) action-entropy detector.
   * Optional so a caller that never opts in can omit it; `undefined` reads as off.
   */
  readonly entropyPlateauDetector?: boolean | undefined;
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
    publishSignal: deps.publishSignal,
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
    correctiveRetries: deps.correctiveRetries,
    ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
    ...(deps.skillSource !== undefined ? { skillSource: deps.skillSource } : {}),
  };
  const generatorLeafDeps = withRoleSpawn(sharedLeafDeps, deps.generatorProvider, opts.generator);
  const evaluatorLeafDeps = {
    ...withRoleSpawn(sharedLeafDeps, deps.evaluatorProvider, opts.evaluator),
    // Evaluator-only: the work-product fingerprint for the plateau predicate. The generator
    // leaf neither needs nor accepts the git runner.
    gitRunner: deps.gitRunner,
  };

  // Provider attribution for both stamp sidecars, and the shared deps of the two post-evaluator
  // plateau detectors (both read the same live turn budget the loop's `shouldContinue` reads).
  const generatorSpawn = roleSpawnConfig(opts.generator);
  const evaluatorSpawn = roleSpawnConfig(opts.evaluator);
  // Both detectors size their window from the SAME operator threshold the calibrated predicate
  // uses, and the entropy one additionally reads its opt-in knob (default off).
  const checkDeps = {
    readConfig: deps.readConfig,
    eventBus: deps.eventBus,
    clock: deps.clock,
    plateauThreshold: deps.plateauThreshold,
  };
  const entropyDeps = { ...checkDeps, enabled: deps.entropyPlateauDetector === true };

  return loop<ImplementCtx>(
    `gen-eval-${String(taskId)}`,
    sequential<ImplementCtx>(`gen-eval-turn-${String(taskId)}`, [
      resolveRoundNumLeaf(taskId),
      stampImplementGeneratorSessionMetaLeaf({ writeFile: deps.writeFile, clock: deps.clock }, generatorSpawn, taskId),
      stampGeneratorRoleMetaLeaf(
        { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
        { ...generatorSpawn, provider: generatorSpawn.providerId },
        taskId
      ),
      generatorLeaf(generatorLeafDeps, taskId),
      guard<ImplementCtx>(
        `evaluator-guard-${String(taskId)}`,
        (ctx) => ctx.lastExit === undefined,
        sequential<ImplementCtx>(`evaluator-step-${String(taskId)}`, [
          stampImplementEvaluatorSessionMetaLeaf(
            { writeFile: deps.writeFile, clock: deps.clock },
            evaluatorSpawn,
            taskId
          ),
          stampEvaluatorRoleMetaLeaf(
            { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
            { ...evaluatorSpawn, provider: evaluatorSpawn.providerId },
            taskId
          ),
          evaluatorLeaf(evaluatorLeafDeps, taskId),
          loopDiversityCheckLeaf(checkDeps, taskId),
          entropyCheckLeaf(entropyDeps, taskId),
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
