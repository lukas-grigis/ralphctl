import { failedDimensions, type PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';

/**
 * Compose the dimension-trajectory feed-forward block the generator reads on round 2+ of the
 * gen-eval loop (principles 6 + 15). The harness already keeps a full per-round record of evaluator
 * verdicts on `ctx.plateauHistory` — failed-dimension sets, critique, work-product fingerprint — but
 * the generator only ever saw the latest critique string. Without the trajectory a generator two
 * stalled rounds from a plateau exit has no signal to change approach until AFTER the loop exits,
 * burns an attempt, and climbs an escalation rung; a cheap prompt-side warning can converge the loop
 * earlier.
 *
 * This block diffs the last evaluator turn's failed-dimension set against the earlier turns to
 * produce three classes of line:
 *  - `fixed since last round`        — a dimension that failed earlier but no longer fails now.
 *  - `still failing (N rounds)`      — a dimension failing in the latest turn AND the prior turn,
 *                                      with the count of consecutive recent rounds it has failed.
 *  - `newly failing`                 — a dimension failing now that did NOT fail in the prior turn.
 *
 * Plus a budget-pressure line when the consecutive-stall count reaches `plateauThreshold - 1` — one
 * round short of the plateau exit — so the generator gets the warning while it can still act on it.
 *
 * Pure. No I/O. Deterministic for a given history (vital for prompt-regression test stability).
 *
 * @public
 */

/** Hard ceiling on dimension lines per class so a many-round attempt can't balloon the prompt. */
const MAX_DIMENSIONS_PER_CLASS = 8;

export interface DimensionTrajectoryInput {
  /** Append-only per-attempt evaluator-turn history — `ctx.plateauHistory`. */
  readonly history: readonly PlateauTurnRecord[];
  /** Configured plateau threshold (`settings.harness.plateauThreshold`); drives the pressure line. */
  readonly plateauThreshold: number;
  /** Current round number — `ctx.currentRoundNum`. Rendered in the pressure line. */
  readonly roundNum: number;
  /** Configured gen-eval turn budget (`settings.harness.maxTurns`). Rendered in the pressure line. */
  readonly maxTurns: number;
}

/**
 * Count, walking the history from the most-recent turn backwards, how many consecutive turns the
 * given dimension stayed in the failed set. Stops at the first turn where the dimension passed (or
 * the history runs out). The latest turn is `history[history.length - 1]`.
 */
const consecutiveFailing = (history: readonly PlateauTurnRecord[], dimension: string): number => {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (record === undefined) break;
    if (failedDimensions(record.evaluation).has(dimension)) streak += 1;
    else break;
  }
  return streak;
};

const sortedLimited = (names: Iterable<string>): readonly string[] =>
  [...names].sort().slice(0, MAX_DIMENSIONS_PER_CLASS);

/**
 * Render the trajectory block, or '' when there is no usable trajectory (fewer than two evaluator
 * turns recorded — nothing to diff). The empty case lets the caller collapse the section cleanly.
 */
export const composeDimensionTrajectory = (input: DimensionTrajectoryInput): string => {
  const { history } = input;
  // Need at least two turns to have a trajectory to diff (latest vs prior).
  if (history.length < 2) return '';

  const latest = history[history.length - 1];
  const prior = history[history.length - 2];
  if (latest === undefined || prior === undefined) return '';

  const latestFailed = failedDimensions(latest.evaluation);
  const priorFailed = failedDimensions(prior.evaluation);

  const fixed = sortedLimited([...priorFailed].filter((d) => !latestFailed.has(d)));
  const newlyFailing = sortedLimited([...latestFailed].filter((d) => !priorFailed.has(d)));
  const stillFailing = sortedLimited([...latestFailed].filter((d) => priorFailed.has(d)));

  const lines: string[] = [];

  for (const d of fixed) {
    lines.push(`- ${d}: fixed since last round — keep it passing.`);
  }
  for (const d of stillFailing) {
    const rounds = consecutiveFailing(history, d);
    lines.push(`- ${d}: STILL FAILING (${String(rounds)} consecutive rounds) — your last change did not resolve it.`);
  }
  for (const d of newlyFailing) {
    lines.push(`- ${d}: newly failing this round — a change regressed it.`);
  }

  if (lines.length === 0) return '';

  // Budget-pressure line: the loop plateaus after `plateauThreshold` consecutive stalled rounds.
  // Fire the warning one round early (the longest still-failing streak has reached
  // `plateauThreshold - 1`) so the generator can change approach before the harness gives up.
  const threshold = Math.max(2, Math.trunc(input.plateauThreshold));
  const longestStall = stillFailing.reduce((max, d) => Math.max(max, consecutiveFailing(history, d)), 0);
  const pressure =
    longestStall >= threshold - 1
      ? [
          '',
          `Round ${String(input.roundNum)} of ${String(input.maxTurns)}; ${String(longestStall)} stalled round(s) — ` +
            `the harness exits this loop at ${String(threshold)} consecutive stalled rounds and escalates. Do NOT ` +
            'repeat the previous approach on a still-failing dimension; step back and try a fundamentally different fix.',
        ]
      : [];

  return ['## Dimension trajectory', '', ...lines, ...pressure].join('\n');
};
