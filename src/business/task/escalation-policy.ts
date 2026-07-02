import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { escalationLadderCyclicFrom, mergeEscalationMap, nextEffortRung } from '@src/business/task/escalation-map.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** Event `type` discriminant for the operator banner every escalation branch publishes. */
const BANNER_SHOW_EVENT = 'banner-show';

/**
 * The gen-eval exit kind that triggered the model-escalation policy. Threaded through so the
 * emitted `model-escalated` event + banner copy name the real cause rather than always saying
 * "plateau". `'malformed'` is absent on purpose — that exit is the evaluator's failure and never
 * climbs the model ladder (the finalize use case routes it to a plain same-model retry instead).
 */
export type EscalationTrigger = 'plateau' | 'budget-exhausted';

/**
 * Human-readable noun for {@link EscalationTrigger}, used in banner / log copy.
 */
const triggerLabel = (trigger: EscalationTrigger): string =>
  trigger === 'plateau' ? 'plateau' : 'turn budget exhausted';

/**
 * Pure policy that decides whether a failure-driven exit should escalate the generator model.
 * Lives separate from {@link finalizeGenEvalUseCase} so the graduated-remedy ladder
 * (cheapest-first, climb the model ladder multiple rungs) + budget edge + map lookup logic is
 * independently unit-testable (no taskRepo / bus stubs needed for the decision itself).
 *
 * Inputs:
 *   - `task`                — the in-flight task with the just-finished escalatable attempt.
 *   - `generatorModel`      — the model the just-finished attempt ran on
 *                             (= `task.escalatedToModel ?? configured`).
 *   - `flagOn`              — `settings.harness.escalateOnPlateau` (gates ALL failure-driven
 *                             escalation, not only plateau — the flag name is retained for
 *                             backward compatibility).
 *   - `userMap`             — `settings.harness.escalationMap`; merged over the built-in default.
 *   - `fallbackMaxAttempts` — effective attempt budget when `task.maxAttempts` is unset (legacy
 *                             tasks planned before the field existed); wired from
 *                             `settings.harness.maxAttempts`.
 *
 * An escalatable exit NEVER blocks. It either grants one more attempt (with a stronger model
 * and/or a change-of-approach directive) or preserves the work (done-with-warning) — never throws
 * it away.
 *
 * The ladder is climbed cheapest-first across SUCCESSIVE escalatable exits: `generatorModel`
 * advances by one rung on each escalate (because the leaf re-reads `escalatedToModel`), so the
 * same policy returns `escalate` repeatedly until the generator reaches the top of the model ladder.
 * At the top — before spending the same-model `nudge` — the policy tries a same-model EFFORT rung
 * (`escalate-effort`) when the provider/model exposes an effort dimension and the generator has
 * headroom. The target is provider-aware ({@link nextEffortRung}): Claude climbs its own tiers (…→
 * `xhigh` → `max`) because Claude Code's default is already `xhigh` on xhigh-capable models, while
 * Copilot/Codex step to a fixed `high`. A further failure then nudges, and a failure after the nudge
 * tops out. The effort rung is what activates a live remedy for the shipped default posture
 * (`claude-opus-4-8`, effort unset → `max`, which sits at the top of the model ladder with no
 * stronger rung above it).
 *
 * Outputs (discriminated):
 *   - `escalate`          — a stronger model rung exists above `generatorModel`; caller re-stamps
 *                           the task (model bump) + emits events. Task stays in_progress for the
 *                           next attempt. Fires once per rung, repeatedly up the ladder.
 *   - `escalate-effort`   — no stronger MODEL rung (generator at the top of the ladder), not yet
 *                           nudged, the provider/model exposes an effort dimension, and the resolved
 *                           generator effort has headroom below its ceiling ({@link nextEffortRung}
 *                           returns a target). Caller raises the generator's reasoning effort to
 *                           that target on the SAME model for one more attempt
 *                           (in_progress); no model change, so the escalation model fields are NOT
 *                           stamped. Fires at most once — the next exit sees the raised effort and
 *                           falls through to the nudge. Requires the caller to supply
 *                           `generatorProvider` / `generatorEffort`; without them the policy behaves
 *                           exactly as before (this rung is never returned).
 *   - `nudge`             — flag on, budget remains, no stronger model rung AND the effort rung is
 *                           unavailable (unsupported provider/model, or already at its effort
 *                           ceiling) AND the task has not yet been nudged at the top. Caller stamps
 *                           the task with the
 *                           SAME model (from === to marks the top-of-ladder nudge), and the generator
 *                           gets a change-of-approach directive. Task stays in_progress for one more
 *                           attempt. No model change.
 *   - `flag-off`          — operator opted out; caller leaves the path unchanged (done-with-warning).
 *   - `topped-out`        — the task was already nudged at the top of the ladder and failed again;
 *                           caller preserves the work (done-with-warning), no new event.
 *   - `budget-exhausted`  — flag on but the next attempt would exceed the effective `maxAttempts`
 *                           (no budget to retry); caller preserves the work (done-with-warning)
 *                           naming the budget.
 */
export type EscalationDecision =
  | { readonly kind: 'escalate'; readonly from: string; readonly to: string }
  | { readonly kind: 'escalate-effort'; readonly model: string; readonly from: string; readonly to: string }
  | { readonly kind: 'nudge'; readonly currentModel: string }
  | { readonly kind: 'flag-off' }
  | { readonly kind: 'topped-out'; readonly model: string }
  | { readonly kind: 'budget-exhausted'; readonly attemptsUsed: number; readonly maxAttempts: number };

export interface DecideEscalationProps {
  readonly task: InProgressTask;
  readonly generatorModel: string;
  readonly flagOn: boolean;
  readonly userMap: Readonly<Record<string, string>>;
  /**
   * Effective attempt budget when `task.maxAttempts` is unset. Legacy tasks planned before the
   * field existed (pre-commit 3992de36) carry no per-task cap; without this the budget check
   * would never fire and a legacy task could climb the ladder unbounded. Wired from
   * `settings.harness.maxAttempts`.
   */
  readonly fallbackMaxAttempts: number;
  /**
   * Provider the generator role runs on — read only to decide whether the same-model EFFORT rung
   * ({@link EscalationDecision} `escalate-effort`) is available (a provider without an effort
   * dimension skips it). OPTIONAL: a caller that does not supply it (or supplies `undefined`) gets
   * the pre-effort-rung behaviour unchanged — the policy never returns `escalate-effort` and falls
   * straight through to the same-model nudge at the top of the model ladder.
   */
  readonly generatorProvider?: AiProvider | undefined;
  /**
   * The generator's currently-resolved reasoning effort (`resolveEffort`/`resolveEffortForRow`), or
   * `undefined` for the CLI default. Read alongside {@link generatorProvider} and
   * {@link generatorModel} to decide whether the effort rung has headroom — the target is
   * provider/model-aware ({@link nextEffortRung}): Claude climbs its own tiers (unset on an
   * xhigh-capable model → `max`), Copilot/Codex step to a fixed `high`, and a generator already at
   * its ceiling falls through to the nudge. OPTIONAL for the same backward-compatibility reason as
   * {@link generatorProvider}.
   */
  readonly generatorEffort?: string | undefined;
}

/**
 * Pure decision function. Walks the conditions in priority order: flag → budget → model mapping →
 * top-of-ladder (already-nudged → effort rung → nudge). Budget is checked before mapping so the
 * operator sees a precise reason when both conditions fail simultaneously (the docs explicitly call
 * this out — "On budget edge: emit warn naming budget exhaustion, not missing mapping").
 *
 * Multi-rung climb: `generatorModel` is the model the just-finished attempt ran on. Because the
 * generator leaf re-reads `escalatedToModel` each attempt, `generatorModel` advances one rung per
 * plateau, so this function returns `escalate` repeatedly until the generator hits the top of the
 * model ladder. At the top it tries a same-model `escalate-effort` rung (to the provider/model-aware
 * target from {@link nextEffortRung}, when the provider/model supports effort and there is headroom),
 * then `nudge` (same-model retry with a change-of-approach directive), and a further plateau after
 * the nudge returns `topped-out` (keep the work).
 */
export const decideEscalation = (props: DecideEscalationProps): EscalationDecision => {
  if (!props.flagOn) return { kind: 'flag-off' };
  // `task.maxAttempts` is the per-task cap stamped at plan time; legacy tasks lack it, so fall
  // back to the configured `settings.harness.maxAttempts` rather than letting the budget check
  // go silent (which would let a legacy task climb the ladder unbounded). Domain entity untouched.
  const effectiveMaxAttempts = props.task.maxAttempts ?? props.fallbackMaxAttempts;
  if (props.task.attempts.length >= effectiveMaxAttempts) {
    return {
      kind: 'budget-exhausted',
      attemptsUsed: props.task.attempts.length,
      maxAttempts: effectiveMaxAttempts,
    };
  }
  const merged = mergeEscalationMap(props.userMap);
  const next = merged[props.generatorModel];
  if (
    next !== undefined &&
    next !== props.generatorModel &&
    !escalationLadderCyclicFrom(merged, props.generatorModel)
  ) {
    // A stronger rung exists above the model the just-finished attempt ran on. Climb to it. This
    // fires on every plateau as the generator advances up the ladder one rung at a time. The
    // cyclic-chain guard keeps an operator-authored `escalationMap` cycle (`{ a: b, b: a }`, which
    // the self-loop warning misses) from driving an unbounded climb — a model on a cycle falls
    // through to the same-model nudge / topped-out path below instead of escalating forever.
    return { kind: 'escalate', from: props.generatorModel, to: next };
  }
  // Top of the model ladder (no stronger rung above `generatorModel`). If the task was already
  // nudged at the top (stamped from === to === generatorModel) and plateaued again, top out and
  // keep the work.
  const nudgedAtTop =
    props.task.escalatedFromModel !== undefined &&
    props.task.escalatedFromModel === props.task.escalatedToModel &&
    props.task.escalatedToModel === props.generatorModel;
  if (nudgedAtTop) return { kind: 'topped-out', model: props.generatorModel };
  // Cheapest remedy before the change-of-approach nudge: raise reasoning effort on the SAME model
  // when the provider/model exposes an effort dimension and there is headroom. The target is
  // provider/model-aware (nextEffortRung): Claude climbs its own tiers (unset on an xhigh-capable
  // model → `max`, so the shipped default `claude-opus-4-8` gets a live escalation step instead of
  // settling done-with-warning after one nudge), Copilot/Codex step to a fixed `high`. Skipped
  // gracefully (falls through to the nudge) when the caller supplied no provider/effort context,
  // the provider/model has no effort knob, or the generator is already at its ceiling.
  const effortTarget = nextEffortRung(props.generatorProvider, props.generatorModel, props.generatorEffort);
  if (effortTarget !== undefined) {
    return {
      kind: 'escalate-effort',
      model: props.generatorModel,
      from: props.generatorEffort ?? 'default',
      to: effortTarget,
    };
  }
  // Top of the ladder, no effort headroom, not yet nudged. Grant one more attempt on the same model
  // with a change-of-approach directive instead of blocking.
  return { kind: 'nudge', currentModel: props.generatorModel };
};

/**
 * Stable banner id keyed by the task. Re-firing a plateau on the same task overwrites in
 * place (the banner adapter dedups by id), and the matching `banner-clear` from the next
 * generator-leaf start releases the slot.
 */
export const escalationBannerId = (taskId: string): string => `model-escalation-${taskId}`;

/**
 * Normalised Shannon entropy over the distribution of action kinds seen in a single gen-eval
 * turn. Rationale: a turn that concentrates its reported actions on a single kind round after
 * round has plateaued — the agent keeps choosing the same kind of move rather than exploring —
 * so low action entropy is a useful break signal independent of the turn budget.
 *
 * Formula: H = -Σ(p · log₂ p) / log₂ K, where K = number of distinct action kinds.
 *
 * Returns 0 for a single-kind distribution (zero diversity — the agent chose only one action
 * type). Returns 1 for a uniform distribution (maximum diversity). Returns 1 when
 * `actionCounts` is empty (no data yet → no evidence of plateau).
 */
export const computeActionEntropy = (actionCounts: Map<string, number>): number => {
  const K = actionCounts.size;
  if (K === 0) return 1; // no data → assume max diversity, no plateau
  if (K === 1) return 0; // single kind → zero diversity

  let total = 0;
  for (const count of actionCounts.values()) total += count;
  if (total === 0) return 1; // all zero counts → treat as no data

  let H = 0;
  for (const count of actionCounts.values()) {
    if (count === 0) continue;
    const p = count / total;
    H -= p * Math.log2(p);
  }
  return H / Math.log2(K);
};

/**
 * Returns `true` when `entropy` falls below `threshold`, indicating that the agent is
 * concentrating on too few action kinds — a leading indicator of algorithmic stasis.
 *
 * `threshold` defaults to 0.25 (calibrated: an agent using only 1 of 4 tools scores 0.0;
 * 2 of 4 tools uniformly scores 0.5; the default catches the most degenerate cases while
 * avoiding false positives on mildly skewed but still progressing runs).
 *
 * `threshold` is clamped to [0.1, 0.5] to prevent misconfiguration from either
 * silencing the signal entirely or triggering on every turn.
 */
export const detectLowEntropy = (entropy: number, threshold = 0.25): boolean => {
  const effective = Math.max(0.1, Math.min(0.5, threshold));
  return entropy < effective;
};

/**
 * Pure predicate — returns `true` when the last `windowSize` entries in `history` are all
 * identical (the gen-eval loop is repeating the same failure fingerprint without progress).
 * Returns `false` when `history` has fewer than `windowSize` entries (insufficient data) or
 * when the tail is diverse.
 *
 * Rationale: a gen-eval loop that re-emits the identical failure fingerprint round after round
 * has plateaued; detecting that repetition is a more reliable break signal than waiting out the
 * turn budget.
 *
 * `windowSize` is clamped to ≥ 2 defensively — a window of 1 would fire after every single
 * turn, which is not useful.
 */
export const detectRepetitiveLoop = (history: readonly string[], windowSize: number): boolean => {
  const effective = Math.max(2, Math.trunc(windowSize));
  if (history.length < effective) return false;
  const tail = history.slice(-effective);
  const first = tail[0];
  return tail.every((f) => f === first);
};

export interface ApplyEscalationProps {
  readonly task: InProgressTask;
  readonly decision: EscalationDecision;
  /**
   * The exit kind that triggered the policy — named in the emitted `model-escalated` event +
   * banner / log copy so a budget-exhausted-driven escalation is not mislabeled as a plateau.
   */
  readonly trigger: EscalationTrigger;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

export interface ApplyEscalationOutput {
  readonly task: InProgressTask;
  /**
   * Reserved for a future decision that needs settle-attempt to block the task. No current
   * decision sets it — an escalatable exit never blocks, so escalate / escalate-effort / nudge stay
   * `in_progress` and flag-off / topped-out / budget-exhausted preserve the work
   * (done-with-warning). The caller still threads it through defensively.
   */
  readonly blockedReason?: string;
}

/**
 * Side-effecting half of the policy — given a {@link decideEscalation} verdict, emit the
 * matching banner + log lines and (for the model-bump path) return the task with the escalation
 * fields stamped. The same-model effort rung (escalate-effort) announces the remedy but stamps
 * nothing (the model is unchanged); the preserve paths (topped-out / budget-exhausted) and flag-off
 * return the task as-is. None set `blockedReason`, because an escalatable exit never blocks. The
 * `trigger` names the originating exit kind in the emitted event + copy.
 *
 * The `flag-off` decision short-circuits — the caller leaves the existing behaviour intact
 * (today's done-with-warning settle) so opting out cleanly preserves the v0.7.0 path.
 */
export const applyEscalation = (props: ApplyEscalationProps): Result<ApplyEscalationOutput, ValidationError> => {
  const { task, decision, trigger, eventBus, clock } = props;
  const log = props.logger.named('task.escalation-policy');
  const bannerId = escalationBannerId(String(task.id));
  const now = clock();
  const cause = triggerLabel(trigger);

  switch (decision.kind) {
    case 'flag-off':
      return Result.ok({ task });
    case 'escalate': {
      const stamped = recordTaskEscalation(task, decision.from, decision.to);
      if (!stamped.ok) return Result.error(stamped.error);
      eventBus.publish({
        type: 'model-escalated',
        taskId: String(task.id),
        attemptN: task.attempts.length,
        from: decision.from,
        to: decision.to,
        reason: trigger,
        at: now,
      });
      eventBus.publish({
        type: BANNER_SHOW_EVENT,
        id: bannerId,
        tier: 'info',
        message: `escalated generator model: ${decision.from} → ${decision.to}`,
        cause,
        at: now,
      });
      log.info(`escalating generator model: ${decision.from} → ${decision.to}`, {
        taskId: String(task.id),
        attemptN: task.attempts.length,
        from: decision.from,
        to: decision.to,
        reason: trigger,
      });
      return Result.ok({ task: stamped.value });
    }
    case 'escalate-effort': {
      // Cheapest same-model remedy: raise reasoning effort on the unchanged model. No model bump, so
      // the escalation model fields are NOT stamped (leaving them untouched keeps the same-model
      // change-of-approach marker for the LATER nudge accurate) and no `model-escalated` event fires
      // — the banner names the effort bump so the operator sees the remedy. The generator leaf reads
      // the raised effort on the next attempt; this policy half only announces the decision.
      eventBus.publish({
        type: BANNER_SHOW_EVENT,
        id: bannerId,
        tier: 'info',
        message: `raised generator effort on '${decision.model}': ${decision.from} → ${decision.to}`,
        cause,
        at: now,
      });
      log.info(`raising generator effort on the same model: ${decision.from} → ${decision.to}`, {
        taskId: String(task.id),
        model: decision.model,
        from: decision.from,
        to: decision.to,
        reason: trigger,
      });
      return Result.ok({ task });
    }
    case 'nudge': {
      // Top of the in-provider ladder: no stronger model to climb to. Keep the model but grant one
      // more attempt with a change-of-approach directive (armed in the generator via the
      // same-model marker `escalatedFromModel === escalatedToModel`). Stamp from===to so the next
      // failure detects the top-of-ladder nudge and returns `topped-out`. No model-escalated event —
      // the model did not change; the banner names the nudge so the operator sees what happened.
      const stamped = recordTaskEscalation(task, decision.currentModel, decision.currentModel);
      if (!stamped.ok) return Result.error(stamped.error);
      eventBus.publish({
        type: BANNER_SHOW_EVENT,
        id: bannerId,
        tier: 'info',
        message: `${cause} on '${decision.currentModel}' (top of ladder) — retrying with a change-of-approach directive`,
        cause,
        at: now,
      });
      log.info('top-of-ladder nudge: retrying on the same model with a change-of-approach directive', {
        taskId: String(task.id),
        currentModel: decision.currentModel,
        reason: trigger,
      });
      return Result.ok({ task: stamped.value });
    }
    case 'topped-out': {
      // The generator climbed to the top of the ladder and the top-of-ladder nudge also failed.
      // Preserve the work (done-with-warning) rather than blocking — matches the flag-off path; an
      // escalatable exit never throws the work away. The warn banner tells the operator the ladder
      // exhausted.
      const message = `ladder exhausted on '${decision.model}' (${cause}); keeping the work`;
      eventBus.publish({
        type: BANNER_SHOW_EVENT,
        id: bannerId,
        tier: 'warn',
        message: 'ladder exhausted — keeping the work',
        cause,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        model: decision.model,
        reason: trigger,
      });
      return Result.ok({ task });
    }
    case 'budget-exhausted': {
      // Escalatable exit on the final allowed attempt — no attempt budget left to retry. Preserve
      // the work.
      const message = `${cause} with attempt budget exhausted (attempts=${String(decision.attemptsUsed)}, maxAttempts=${String(decision.maxAttempts)}); keeping the work`;
      eventBus.publish({
        type: BANNER_SHOW_EVENT,
        id: bannerId,
        tier: 'warn',
        message: `${cause}, attempt budget exhausted — keeping the work`,
        cause: `attempts=${String(decision.attemptsUsed)}/${String(decision.maxAttempts)}`,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
        reason: trigger,
      });
      return Result.ok({ task });
    }
  }
};
