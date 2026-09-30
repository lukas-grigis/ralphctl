import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { EvaluateExpect } from './fixture-schema.ts';
import type { DetectScriptsGrade, EvaluateGrade, ImplementGrade, SelectCandidateGrade } from './types.ts';

/**
 * Pure code graders, one per flow. No model grader in v1: code graders are "Fast, Cheap, Objective,
 * Reproducible" (Anthropic, Demystifying evals) and the repo already rejected multi-judge ensembles
 * (`RESEARCH-REFERENCES.md`, "Evaluated and NOT adopted"). The graders never see a model's prose
 * beyond the two `evidence` / `critique` string checks the fixture explicitly asks for.
 */

export interface EvaluationOutcome {
  /** `signals.json` validated against the evaluator contract. */
  readonly valid: boolean;
  readonly signal?: EvaluationSignal;
}

/**
 * Grade one evaluator trial. `correct` is exactly `signal.status === expect.status`; a `malformed`
 * status or a failed validation is incorrect and structurally invalid. The secondary fields ride
 * along for diagnosis and never change `correct`.
 */
export const gradeEvaluation = (
  expect: EvaluateExpect,
  outcome: EvaluationOutcome,
  taskCriterionIds: readonly string[]
): EvaluateGrade => {
  const signal = outcome.valid ? outcome.signal : undefined;
  const structurallyValid = signal !== undefined && signal.status !== 'malformed';
  if (signal === undefined) {
    return {
      flow: 'evaluate',
      correct: false,
      structurallyValid: false,
      status: null,
      dimensionHit: expect.failedDimensions === undefined ? null : false,
      criteriaMatch: {},
      unverifiedCompliance: null,
      missingCriteria: [...taskCriterionIds],
      markerHit: expect.critiqueMarkers === undefined ? null : false,
    };
  }

  const failedNames = new Set(
    signal.dimensions.filter((d) => !d.passed && d.applicable !== false).map((d) => d.dimension.trim().toLowerCase())
  );
  const dimensionHit =
    expect.failedDimensions === undefined ? null : expect.failedDimensions.every((d) => failedNames.has(d));

  const byId = new Map((signal.criteria ?? []).map((c) => [c.id, c]));
  const criteriaMatch: Record<string, boolean> = {};
  const prefixChecks: boolean[] = [];
  for (const [id, want] of Object.entries(expect.criteria ?? {})) {
    const got = byId.get(id);
    const passedOk = want.passed === undefined || got?.passed === want.passed;
    const prefixOk = want.evidencePrefix === undefined || got?.evidence?.startsWith(want.evidencePrefix) === true;
    if (want.evidencePrefix !== undefined) prefixChecks.push(prefixOk);
    criteriaMatch[id] = got !== undefined && passedOk && prefixOk;
  }

  const critique = signal.critique ?? '';
  return {
    flow: 'evaluate',
    correct: structurallyValid && signal.status === expect.status,
    structurallyValid,
    status: signal.status,
    dimensionHit,
    criteriaMatch,
    unverifiedCompliance: prefixChecks.length === 0 ? null : prefixChecks.every(Boolean),
    missingCriteria: taskCriterionIds.filter((id) => !byId.has(id)),
    markerHit: expect.critiqueMarkers === undefined ? null : expect.critiqueMarkers.every((m) => critique.includes(m)),
  };
};

export interface ImplementOutcome {
  readonly valid: boolean;
  /** The hidden oracle exited 0 (run by the runner, never by the model — see `oracle.ts`). */
  readonly oraclePassed: boolean;
  /** Every path the model changed in the workspace (tracked or untracked), repo-relative. */
  readonly changedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly claimedComplete: boolean;
}

/** `path` is one of `protectedPaths` or sits under a protected directory (`test/` matches `test/a.mjs`). */
export const isProtectedPath = (path: string, protectedPaths: readonly string[]): boolean =>
  protectedPaths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));

/**
 * Grade one implement trial: `correct = oracle exit 0 && no protected path changed`. The runner
 * establishes ground truth itself, mirroring the reproduce re-run — "Make your graders resistant to
 * bypasses or hacks" (Anthropic, Demystifying evals).
 */
export const gradeImplement = (outcome: ImplementOutcome): ImplementGrade => {
  const protectedPathsTouched = outcome.changedPaths.filter((p) => isProtectedPath(p, outcome.protectedPaths));
  const correct = outcome.oraclePassed && protectedPathsTouched.length === 0;
  return {
    flow: 'implement',
    correct,
    structurallyValid: outcome.valid,
    oraclePassed: outcome.oraclePassed,
    protectedPathsTouched,
    falseCompletion: outcome.claimedComplete && !outcome.oraclePassed,
  };
};

export interface DetectScriptsOutcome {
  readonly valid: boolean;
  readonly proposed: string | null;
  readonly cleanPasses: boolean | null;
  readonly brokenFails: boolean | null;
  readonly expectedVerifyScript?: string;
}

/**
 * Grade one detect-scripts trial by OUTCOME, not string match: the proposed `verify-script` must
 * exit 0 on a clean copy and non-zero on the broken copy. "It's often better to grade what the
 * agent produced, not the path it took" (Anthropic); exact-match graders are "Brittle to valid
 * variations that don't match expected patterns exactly". The exact match rides along as a
 * secondary, informational field.
 */
export const gradeDetectScripts = (outcome: DetectScriptsOutcome): DetectScriptsGrade => ({
  flow: 'detect-scripts',
  correct: outcome.proposed !== null && outcome.cleanPasses === true && outcome.brokenFails === true,
  structurallyValid: outcome.valid,
  proposed: outcome.proposed,
  cleanPasses: outcome.cleanPasses,
  brokenFails: outcome.brokenFails,
  exactMatch:
    outcome.expectedVerifyScript === undefined || outcome.proposed === null
      ? null
      : outcome.proposed.trim() === outcome.expectedVerifyScript.trim(),
});

export type CandidateOrder = 'ab' | 'ba';

export interface SelectCandidateOutcome {
  readonly valid: boolean;
  /** `CandidateSelectionSignal.winner`: 1-based slot, `0` = tie. */
  readonly winnerSlot: number | undefined;
  readonly order: CandidateOrder;
  readonly winner: 'a' | 'b';
}

/** Map the judge's 1-based slot back to candidate `a` / `b` for the order this trial showed them in. */
export const pickedCandidate = (slot: number | undefined, order: CandidateOrder): SelectCandidateGrade['picked'] => {
  if (slot === 0) return 'tie';
  if (slot !== 1 && slot !== 2) return 'none';
  const first = order === 'ab' ? 'a' : 'b';
  const second = order === 'ab' ? 'b' : 'a';
  return slot === 1 ? first : second;
};

export const gradeSelectCandidate = (outcome: SelectCandidateOutcome): SelectCandidateGrade => {
  const picked = outcome.valid ? pickedCandidate(outcome.winnerSlot, outcome.order) : 'none';
  return {
    flow: 'select-candidate',
    correct: picked === outcome.winner,
    structurallyValid: outcome.valid,
    picked,
  };
};
