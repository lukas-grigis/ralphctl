import type { TrialRecord } from '../../scripts/eval/types.ts';

/** A graded, correct, structurally valid evaluate trial; override any field. */
export const trial = (over: Partial<TrialRecord> = {}): TrialRecord => ({
  fixtureId: 'fx-1',
  flow: 'evaluate',
  variant: 'defect',
  trialIndex: 1,
  arm: 'baseline',
  tier: 'regression',
  cluster: 'c1',
  origin: 'synthetic',
  defectClass: 'correctness',
  graded: true,
  correct: true,
  structurallyValid: true,
  nudgeCount: 0,
  usage: { inputTokens: 100, outputTokens: 20, durationMs: 1000, metered: true },
  artifactDir: 'trials/x',
  ...over,
});

/**
 * `k` trials of one item on one arm; `pattern` gives each trial's `correct` (cycled). Extra fields
 * (variant, cluster, defectClass, …) apply to every trial.
 */
export const itemTrials = (
  fixtureId: string,
  arm: string,
  pattern: readonly boolean[],
  over: Partial<TrialRecord> = {}
): TrialRecord[] => pattern.map((correct, i) => trial({ fixtureId, arm, trialIndex: i + 1, correct, ...over }));
