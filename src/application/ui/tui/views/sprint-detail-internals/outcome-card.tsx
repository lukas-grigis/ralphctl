/**
 * Outcome report card — a sprint-scoped read-only rollup answering "what did the harness catch,
 * and what resolved each stall". Folds the sprint's already-loaded tasks through
 * `foldOutcomeStats` (`src/business/runs/outcome-stats.ts`); no I/O, no new loader.
 *
 * Deliberately minimal (council-scoped): outcome mix, first-pass rate, plateau-by-source (only
 * nonzero sources), escalation-rung efficacy (only rungs that fired at least once), and the
 * criteria k/N. No attempts-to-done histogram, no failed-dimension breakdown, no cross-sprint
 * trend — those are explicitly out of scope here.
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
  type EscalationRung,
  foldOutcomeStats,
  type OutcomeRollup,
  type PlateauSourceKey,
  type RungEfficacy,
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

const outcomeMixLine = (rollup: OutcomeRollup): string => {
  const { outcomes, taskCount } = rollup;
  const open = outcomes.byStatus.todo + outcomes.byStatus.in_progress;
  return (
    `${String(outcomes.doneClean)} clean ${glyphs.bullet} ${String(outcomes.doneWithWarning)} warn ` +
    `${glyphs.bullet} ${String(outcomes.byStatus.blocked)} blocked ${glyphs.bullet} ${String(open)} open` +
    `  (${String(taskCount)} total)`
  );
};

const plateauLine = (rollup: OutcomeRollup): string | undefined => {
  const entries = Object.entries(rollup.plateau.bySource) as ReadonlyArray<readonly [PlateauSourceKey, number]>;
  const nonzero = entries.filter(([, count]) => count > 0);
  if (nonzero.length === 0) return undefined;
  return nonzero.map(([source, count]) => `${PLATEAU_LABEL[source]} ${glyphs.bullet}${String(count)}`).join('  ');
};

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

  const fields: Field[] = [
    { label: 'Outcomes', value: outcomeMixLine(totals) },
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
      <Card title="Outcome report" tone="info">
        <FieldList fields={fields} />
      </Card>
    </Box>
  );
};
