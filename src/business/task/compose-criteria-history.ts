import type { CriteriaVerdicts, CriterionStatus, VerificationCriterion } from '@src/domain/entity/task.ts';

/**
 * Compose the compact per-criterion verdict block a FRESH attempt reads so it inherits the durable
 * k-of-N checklist state earned by prior rounds (principle 3 / harness-memory). `Task.criteriaVerdicts`
 * persists the latest PASS / FAIL / UNKNOWN per criterion across rounds, but on a fresh attempt (a
 * post-escalation retry starts a brand-new session) neither the generator nor the evaluator sees that
 * history in-conversation — the prior thread is gone. This block feed-forwards it so the generator knows
 * which criteria already pass (keep them green) and which still fail (where to focus), and the evaluator
 * knows the checklist is multi-round rather than a fresh binary.
 *
 * Neutral by design — the block states facts (k-of-N summary + per-criterion status) with NO
 * role-specific directive, because the same block rides both the generator and evaluator prompts; each
 * template adds its own framing around the `{{PRIOR_CRITERIA_VERDICTS}}` placeholder.
 *
 * Deterministic for a given input (criteria rendered in their declared order), which keeps the
 * prompt-regression tests stable.
 *
 * Pure. No I/O.
 *
 * @public
 */
export interface CriteriaHistoryInput {
  /** The task's declared done-criteria — rendered in order so the block mirrors the contract. */
  readonly verificationCriteria: readonly VerificationCriterion[];
  /** Harness-owned per-criterion verdict map (`Task.criteriaVerdicts`); absent until the first fold. */
  readonly verdicts: CriteriaVerdicts | undefined;
}

const STATUS_LABEL: Readonly<Record<CriterionStatus, string>> = {
  passed: 'passing',
  failed: 'failing',
  unknown: 'not yet graded',
};

/**
 * Render the block, or '' when there is no usable history — a missing/empty verdict map, no declared
 * criteria, or a map in which no criterion has yet been graded (all `unknown`). The empty case lets the
 * caller collapse the `{{PRIOR_CRITERIA_VERDICTS}}` placeholder cleanly without an orphan heading.
 */
export const composeCriteriaHistory = (input: CriteriaHistoryInput): string => {
  const { verificationCriteria, verdicts } = input;
  if (verdicts === undefined || verificationCriteria.length === 0) return '';

  const status = (id: string): CriterionStatus => verdicts[id] ?? 'unknown';
  // Nothing worth surfacing until at least one criterion carries a real (non-unknown) verdict — a map
  // that only ever seeded `unknown` slots is not a history the fresh attempt can learn from.
  const graded = verificationCriteria.filter((c) => status(c.id) !== 'unknown');
  if (graded.length === 0) return '';

  const passing = verificationCriteria.filter((c) => status(c.id) === 'passed').length;
  const total = verificationCriteria.length;
  const bullets = verificationCriteria.map((c) => `- ${c.id}: ${STATUS_LABEL[status(c.id)]}`);

  return [
    '## Prior criteria verdicts',
    '',
    `Durable per-criterion verdicts recorded by earlier rounds — ${String(passing)} of ${String(total)} done-criteria passing as of the last graded round:`,
    ...bullets,
  ].join('\n');
};
