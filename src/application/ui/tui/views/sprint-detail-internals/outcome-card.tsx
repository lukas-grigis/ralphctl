/**
 * Outcome report card — a sprint-scoped read-only rollup answering "what did the harness catch,
 * and what resolved each stall". Folds the sprint's already-loaded tasks through
 * `foldOutcomeStats` (`src/business/runs/outcome-stats.ts`); no I/O, no new loader.
 *
 * Deliberately minimal (council-scoped): outcome mix, first-pass rate, plateau-by-source (only
 * nonzero sources), the regression / warning / abort taxonomy (regressions and warnings always,
 * aborts only when one happened), escalation-rung efficacy (only rungs that fired at least once),
 * and the criteria k/N. No attempts-to-done histogram, no failed-dimension breakdown, no
 * cross-sprint trend — those are explicitly out of scope here.
 *
 * Task-based and attempt-based numbers coexist here, so the attempt-based ones say so in their
 * value text ("1 of 2 attributed attempts") rather than leaving a bare count to be read against
 * the task counts above it.
 *
 * Shown only for `review` / `done` sprints (see `SprintDetailContent`'s `Body`) — the report has
 * nothing to say before the harness has run an attempt.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList, type Field } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import {
  type AbortCauseKey,
  type EscalationRung,
  foldOutcomeStats,
  type OutcomeRollup,
  type PlateauSourceKey,
  type RungEfficacy,
  type WarningKindKey,
} from '@src/business/runs/outcome-stats.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';

const PLATEAU_LABEL: Readonly<Record<PlateauSourceKey, string>> = {
  threshold: 'threshold',
  diversity: 'diversity',
  entropy: 'entropy',
  unspecified: 'unspecified',
};

const RUNG_LABEL: Readonly<Record<EscalationRung, string>> = {
  model: 'Model',
  effort: 'Effort',
  'evaluator-effort': 'Evaluator effort',
  nudge: 'Nudge',
  'best-of-n': 'Best-of-N',
};

const pct = (rate: number): string => `${String(Math.round(rate * 100))}%`;

/**
 * One-line `label count` list, separated by the theme bullet — the same separator idiom every
 * sibling line in this card uses (`regressionLine`, `outcomeMixLine`, `rungFields`).
 */
const joinCounts = (entries: ReadonlyArray<readonly [string, number]>): string | undefined => {
  const nonzero = entries.filter(([, count]) => count > 0);
  if (nonzero.length === 0) return undefined;
  return nonzero.map(([label, count]) => `${label} ${String(count)}`).join(` ${glyphs.bullet} `);
};

/**
 * The severity row. `attributed` — not the raw attempt count — is the denominator, because an
 * attempt whose pre/post verify pair never ran carries no verdict either way; quoting it would
 * make a repo with no verify script look regression-free.
 */
const regressionLine = (rollup: OutcomeRollup): string => {
  const { attributed, byVerdict } = rollup.attribution;
  if (attributed === 0) return 'no attribution verdicts';
  if (byVerdict.regressed === 0) return `none ${glyphs.bullet} ${String(attributed)} attributed attempts`;
  return `${String(byVerdict.regressed)} of ${String(attributed)} attributed attempts`;
};

const warningLine = (rollup: OutcomeRollup): string | undefined =>
  joinCounts(Object.entries(rollup.warnings.byKind) as ReadonlyArray<readonly [WarningKindKey, number]>);

const abortLine = (rollup: OutcomeRollup): string | undefined =>
  joinCounts(Object.entries(rollup.aborts.byCause) as ReadonlyArray<readonly [AbortCauseKey, number]>);

const outcomeMixLine = (rollup: OutcomeRollup): string => {
  const { outcomes, taskCount } = rollup;
  const open = outcomes.byStatus.todo + outcomes.byStatus.in_progress;
  return (
    `${String(outcomes.doneClean)} clean ${glyphs.bullet} ${String(outcomes.doneWithWarning)} warn ` +
    `${glyphs.bullet} ${String(outcomes.byStatus.blocked)} blocked ${glyphs.bullet} ${String(open)} open` +
    `  (${String(taskCount)} total)`
  );
};

const plateauLine = (rollup: OutcomeRollup): string | undefined =>
  joinCounts(
    (Object.entries(rollup.plateau.bySource) as ReadonlyArray<readonly [PlateauSourceKey, number]>).map(
      ([source, count]) => [PLATEAU_LABEL[source], count] as const
    )
  );

const rungFields = (rollup: OutcomeRollup): readonly Field[] => {
  const entries = Object.entries(rollup.escalation) as ReadonlyArray<readonly [EscalationRung, RungEfficacy]>;
  return entries
    .filter(([, efficacy]) => efficacy.granted > 0)
    .map(([rung, efficacy]) => ({
      label: RUNG_LABEL[rung],
      value: `${String(efficacy.granted)} granted ${glyphs.bullet} ${String(efficacy.resolved)} resolved`,
    }));
};

/**
 * True once the rollup carries at least one genuine attempt-shaped signal — a completion, a
 * plateau, a granted escalation rung, or a declared criteria checklist. `false` means the loaded
 * tasks are empty or entirely pre-attempt (a fresh/legacy sprint), so the report has nothing
 * concrete to say yet.
 */
const hasAttemptData = (rollup: OutcomeRollup): boolean =>
  rollup.attemptCount > 0 ||
  rollup.firstPass.doneTotal > 0 ||
  rollup.plateau.attemptsWithPlateau > 0 ||
  rollup.criteria.declared > 0 ||
  Object.values(rollup.escalation).some((efficacy) => efficacy.granted > 0);

export interface OutcomeReportCardProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

export const OutcomeReportCard = ({ sprint, tasks }: OutcomeReportCardProps): React.JSX.Element => {
  const { totals } = foldOutcomeStats([{ sprint, tasks }]);

  if (!hasAttemptData(totals)) {
    return (
      <Box marginTop={spacing.section}>
        <Card title="Outcome report" tone="rule">
          <Text dimColor>No attempt data recorded for this sprint.</Text>
        </Card>
      </Box>
    );
  }

  const aborts = abortLine(totals);
  const fields: Field[] = [
    { label: 'Outcomes', value: outcomeMixLine(totals) },
    { label: 'Regressions', value: regressionLine(totals) },
    { label: 'Warnings', value: warningLine(totals) ?? 'none' },
    // Omitted entirely on the happy path — an always-"none" row is noise on a minimal card.
    ...(aborts === undefined ? [] : [{ label: 'Aborts', value: aborts }]),
    {
      label: 'First pass',
      value:
        totals.firstPass.doneTotal > 0
          ? `${String(totals.firstPass.doneOnFirstAttempt)}/${String(totals.firstPass.doneTotal)} (${pct(totals.firstPass.rate)})`
          : 'no completions yet',
    },
    { label: 'Plateaus', value: plateauLine(totals) ?? 'none' },
    ...rungFields(totals),
    {
      label: 'Criteria',
      value:
        totals.criteria.declared > 0
          ? `${String(totals.criteria.passed)}/${String(totals.criteria.declared)} passed (${pct(totals.criteria.passRate)})` +
            (totals.criteria.unknown > 0 ? `  ${String(totals.criteria.unknown)} unknown` : '')
          : 'not declared',
    },
  ];

  return (
    <Box marginTop={spacing.section}>
      {/* A broken baseline is the one post-mortem finding that should shout, so it takes the
          error tone — a `CardTone` token, not an inline colour. */}
      <Card title="Outcome report" tone={totals.attribution.byVerdict.regressed > 0 ? 'error' : 'info'}>
        <FieldList fields={fields} />
      </Card>
    </Box>
  );
};
