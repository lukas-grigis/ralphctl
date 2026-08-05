import { Result } from '@src/domain/result.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { evaluatorLeaf, type EvaluatorLeafDeps } from '@src/application/flows/implement/leaves/evaluator.ts';
import { generatorLeaf, type GeneratorLeafDeps } from '@src/application/flows/implement/leaves/generator.ts';
import { entropyCheckLeaf } from '@src/application/flows/implement/leaves/entropy-check.ts';
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
import { roleSpawnConfig, withRoleSpawn } from '@src/application/flows/implement/leaves/_shared/role-spawn.ts';
import {
  bestOfNCandidateLoopLeaf,
  type BestOfNGenEvalOpts,
} from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';
import { persistBestOfNGrantConsumedLeaf } from '@src/application/flows/implement/leaves/best-of-n-grant-consumed.ts';
import { bestOfNSelectionLeaf } from '@src/application/flows/implement/leaves/best-of-n-selection.ts';

// `BestOfNGenEvalOpts` re-exported so a consumer typing a call to `buildBestOfNGenEvalLoop` below
// doesn't need to know it's structurally defined in the sibling candidate module.
// `toBestOfNGenEvalOpts` / `BestOfNCandidateRecord` are NOT re-exported here — every current
// consumer (`attempt-body.ts`, `ctx.ts`, `best-of-n-selection.ts`) imports them directly from
// `best-of-n-candidate.ts` / `best-of-n-record.ts`.
export type { BestOfNGenEvalOpts } from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';

/**
 * Best-of-N execution — the escalation policy's opt-in top-of-ladder remedy (see
 * `business/task/escalation-policy.ts`'s `'best-of-n'` decision). When a task's granted attempt
 * runs, this composite REPLACES round 1's normal generator phase with a candidate-sampling loop
 * (arXiv 2604.16529: harness-level N-candidate selection) + a selection cascade (arXiv 2507.23370:
 * Trae's ablation order — execution filter, then dedupe, then judge), applies the winning diff,
 * then hands off to round 1's NORMAL evaluator turn and — for rounds 2+, if the round-1 evaluator
 * doesn't reach a terminal verdict — the SAME `generatorLeaf` / `evaluatorLeaf` every other attempt
 * uses. No bespoke settle logic: the attempt rejoins `finalize-gen-eval` / `settle-attempt` exactly
 * like a normal attempt once this composite's `loop` exits.
 *
 * Detection: `attempt-body.ts` reads the STATIC `settings.harness.bestOfNCandidates` knob at
 * element-CONSTRUCTION time to decide whether to splice this composite in at all (knob off →
 * `createGenEvalLoop` is the only element built, byte-for-byte the pre-existing shape). When the
 * knob is on, BOTH this composite and the normal `createGenEvalLoop` are built, each behind a
 * `guard` reading {@link isBestOfNGranted} / {@link hasBestOfNCompositeRun} at RUNTIME — the
 * once-per-task grant fires on at most one specific attempt of a task, so every other attempt
 * (before and after the granted one) takes the normal guard and runs `createGenEvalLoop` unchanged.
 */

/**
 * Runtime predicate for the FIRST outer guard choosing between this composite and the normal
 * `createGenEvalLoop` — true only for the ONE attempt the escalation policy granted (the
 * transient `task.bestOfNGrantedCandidates` handshake; see `domain/entity/task.ts`'s field
 * JSDoc). `bestOfNSelectionLeaf` consumes (clears) this field once sampling finishes, so a
 * SUBSEQUENT attempt of the same task — even a retry after the granted attempt's evaluator failed
 * it — reads `undefined` here and falls through to the normal guard.
 *
 * Only safe as the FIRST of the two `attempt-body.ts` outer guards — see
 * {@link hasBestOfNCompositeRun} for why the SECOND one reads a different, stable signal instead
 * of `!isBestOfNGranted`.
 *
 * @public
 */
export const isBestOfNGranted = (ctx: ImplementCtx): boolean => ctx.currentTask?.bestOfNGrantedCandidates !== undefined;

/**
 * True once this attempt's best-of-N composite has executed at least one turn — reads
 * `ctx.bestOfNLoopTurn`, stamped once per turn INSIDE this composite (see
 * {@link advanceBestOfNLoopTurnLeaf}) and never touched by anything outside it.
 *
 * `attempt-body.ts`'s second outer guard (`normal-gen-eval-branch`) reads THIS — never
 * `!isBestOfNGranted` — as its predicate. Both outer guards are evaluated independently, in
 * sequence, by the surrounding `sequential`; the second one only after the WHOLE composite
 * (potentially several turns) has returned. `bestOfNSelectionLeaf` clears the transient
 * `task.bestOfNGrantedCandidates` partway through that same composite (so a LATER attempt of the
 * task doesn't re-trigger it) — if the second guard re-derived its decision from that same
 * mutable task field, it would misread "not granted" once the composite finishes and ALSO run the
 * normal loop, doubling the attempt's turn budget. Reading this composite-scoped counter's
 * definedness instead survives that mutation: it is stamped the instant the composite starts and
 * stays defined for the rest of the attempt, regardless of what the selection leaf clears.
 *
 * @public
 */
export const hasBestOfNCompositeRun = (ctx: ImplementCtx): boolean => ctx.bestOfNLoopTurn !== undefined;

/**
 * True on the FIRST turn of THIS attempt's best-of-N composite — gates the round-1-substitute
 * guard vs the round-2+-generator guard. Reads `ctx.bestOfNLoopTurn`, stamped by
 * {@link advanceBestOfNLoopTurnLeaf} once per turn, BEFORE either guard evaluates, and untouched
 * by both guarded branches — so the two guards stay mutually exclusive WITHIN one turn, exactly
 * like the disk-derived `currentRoundNum === 1` check this replaced.
 *
 * That prior check gated on `ctx.currentRoundNum`, which `resolveRoundNumLeaf` derives from
 * `max(rounds/<N>/ already on disk) + 1` — claimed PER TASK across every attempt, not per attempt.
 * A best-of-N grant never lands before a task's 3rd attempt (the escalation policy only grants at
 * `nudgedAtTop`, itself downstream of a prior plateau + nudge), and every earlier attempt already
 * wrote at least one `rounds/<N>/` directory to disk — so on the granted attempt's very first turn
 * `currentRoundNum` was already 3 or higher and the substitute never fired; the whole opt-in
 * remedy silently degraded to a plain gen-eval loop. `ctx.bestOfNLoopTurn` is attempt-scoped
 * (reset by `start-attempt`, like `currentRoundNum` itself), so turn 1 of THIS composite is always
 * `1` regardless of how many rounds prior attempts of the same task already wrote to disk.
 */
const isBestOfNFirstTurn = (ctx: ImplementCtx): boolean => ctx.bestOfNLoopTurn === 1;

/**
 * Stamp `ctx.bestOfNLoopTurn` — the turn sequential's SECOND element (right after
 * `resolveRoundNumLeaf`), so it lands before either the round-1-substitute or the
 * round-2+-generator guard reads it. A pure ctx counter increment; no I/O, no use-case logic.
 */
const advanceBestOfNLoopTurnLeaf = (taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, number, number>(`best-of-n-advance-turn-${String(taskId)}`, {
    useCase: { execute: (input) => Promise.resolve(Result.ok(input)) },
    input: (ctx) => (ctx.bestOfNLoopTurn ?? 0) + 1,
    output: (ctx, out) => ({ ...ctx, bestOfNLoopTurn: out }),
  });

/**
 * Build this composite's evaluator step — literally the same sequence
 * `gen-eval-loop.ts`'s per-turn body runs for the evaluator half, reusing the SAME exported leaf
 * factories, so round 1's "normal evaluator turn" (and every later round's) cannot drift from the
 * non-granted path's evaluator behaviour.
 */
const buildEvaluatorStep = (
  deps: ImplementDeps,
  taskId: TaskId,
  evaluatorLeafDeps: EvaluatorLeafDeps,
  evaluatorSpawn: { readonly providerId: string; readonly model: string; readonly effort?: string }
): Element<ImplementCtx> => {
  const checkDeps = {
    readConfig: async () => ({ maxTurns: deps.config.harness.maxTurns }),
    eventBus: deps.eventBus,
    clock: deps.clock,
  };
  return sequential<ImplementCtx>(`best-of-n-evaluator-step-${String(taskId)}`, [
    stampImplementEvaluatorSessionMetaLeaf({ writeFile: deps.writeFile, clock: deps.clock }, evaluatorSpawn, taskId),
    stampEvaluatorRoleMetaLeaf(
      { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
      { ...evaluatorSpawn, provider: evaluatorSpawn.providerId },
      taskId
    ),
    evaluatorLeaf(evaluatorLeafDeps, taskId),
    loopDiversityCheckLeaf(checkDeps, taskId),
    entropyCheckLeaf(checkDeps, taskId),
  ]);
};

/**
 * Build the normal (round 2+) generator step — the SAME stamp + `generatorLeaf` sequence
 * `gen-eval-loop.ts` runs, reused verbatim.
 */
const buildNormalGeneratorStep = (
  deps: ImplementDeps,
  taskId: TaskId,
  generatorLeafDeps: GeneratorLeafDeps,
  generatorSpawn: { readonly providerId: string; readonly model: string; readonly effort?: string }
): Element<ImplementCtx> =>
  sequential<ImplementCtx>(`best-of-n-generator-turn-${String(taskId)}`, [
    stampImplementGeneratorSessionMetaLeaf({ writeFile: deps.writeFile, clock: deps.clock }, generatorSpawn, taskId),
    stampGeneratorRoleMetaLeaf(
      { writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
      { ...generatorSpawn, provider: generatorSpawn.providerId },
      taskId
    ),
    generatorLeaf(generatorLeafDeps, taskId),
  ]);

/**
 * Round 1's generator-phase REPLACEMENT: sample candidates, select, apply. See
 * `best-of-n-candidate.ts` / `best-of-n-selection.ts` for the two stages.
 */
const buildRound1Substitute = (deps: ImplementDeps, opts: BestOfNGenEvalOpts, taskId: TaskId): Element<ImplementCtx> =>
  sequential<ImplementCtx>(`best-of-n-round1-${String(taskId)}`, [
    // Persists the grant's consumption to disk BEFORE any candidate spawns — see
    // `persistBestOfNGrantConsumedLeaf`'s docstring for why this can't wait for selection to
    // clear the ctx-level field.
    persistBestOfNGrantConsumedLeaf(deps, taskId),
    bestOfNCandidateLoopLeaf(deps, opts, taskId),
    bestOfNSelectionLeaf(deps, opts, taskId),
  ]);

/**
 * The best-of-N gen-eval loop — a `loop` with the SAME `shouldContinue` / `shouldStop` shape
 * `createGenEvalLoop` uses (so the total turn budget for the attempt is unchanged), whose body
 * swaps ONLY round 1's generator step for {@link buildRound1Substitute}; round 2+ (only reached
 * if round 1's evaluator did not set a terminal `lastExit`) runs the normal generator + evaluator
 * turn, byte-for-byte the same leaves the non-granted path spawns.
 *
 * @public
 */
export const buildBestOfNGenEvalLoop = (
  deps: ImplementDeps,
  opts: BestOfNGenEvalOpts,
  taskId: TaskId,
  readConfig: () => Promise<{ readonly maxTurns: number }>
): Element<ImplementCtx> => {
  const sharedLeafDeps = {
    templateLoader: deps.templateLoader,
    publishSignal: deps.publishSignal,
    writeFile: deps.writeFile,
    cwd: opts.cwd,
    sprintDir: opts.sprintDir,
    progressFile: opts.progressFile,
    clock: deps.clock,
    logger: deps.logger,
    eventBus: deps.eventBus,
    maxTurns: deps.config.harness.maxTurns,
    plateauThreshold: deps.config.harness.plateauThreshold,
    correctiveRetries: deps.config.harness.correctiveRetries,
    ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
    ...(deps.skillSource !== undefined ? { skillSource: deps.skillSource } : {}),
  };
  const generatorLeafDeps = withRoleSpawn(sharedLeafDeps, deps.generatorProvider, opts.generator);
  const evaluatorLeafDeps = {
    ...withRoleSpawn(sharedLeafDeps, deps.evaluatorProvider, opts.evaluator),
    gitRunner: deps.gitRunner,
  };
  const generatorSpawn = roleSpawnConfig(opts.generator);
  const evaluatorSpawn = roleSpawnConfig(opts.evaluator);

  const round1Substitute = buildRound1Substitute(deps, opts, taskId);
  const normalGeneratorStep = buildNormalGeneratorStep(deps, taskId, generatorLeafDeps, generatorSpawn);
  const evaluatorStep = buildEvaluatorStep(deps, taskId, evaluatorLeafDeps, evaluatorSpawn);

  return loop<ImplementCtx>(
    `gen-eval-best-of-n-${String(taskId)}`,
    sequential<ImplementCtx>(`gen-eval-turn-best-of-n-${String(taskId)}`, [
      resolveRoundNumLeaf(taskId),
      advanceBestOfNLoopTurnLeaf(taskId),
      guard<ImplementCtx>(`best-of-n-round1-guard-${String(taskId)}`, isBestOfNFirstTurn, round1Substitute),
      guard<ImplementCtx>(
        `best-of-n-continue-guard-${String(taskId)}`,
        (ctx) => !isBestOfNFirstTurn(ctx),
        normalGeneratorStep
      ),
      guard<ImplementCtx>(`evaluator-guard-${String(taskId)}`, (ctx) => ctx.lastExit === undefined, evaluatorStep),
    ]),
    {
      // Same loop-entry guard as `createGenEvalLoop` — refuse a turn when a terminal exit is
      // already on ctx (the pre-task-verify hard-block case), same turn-budget cap.
      shouldContinue: async (ctx, i) => {
        const cfg = await readConfig();
        return ctx.lastExit === undefined && i <= Math.max(1, cfg.maxTurns);
      },
      shouldStop: (ctx) => ctx.lastExit !== undefined,
    }
  );
};
