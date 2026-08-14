/**
 * Human-readable projection of the harness outcome rollup. Pure: `OutcomeStats` in, text out —
 * no clock, no filesystem, no `process.stdout`. Every number rendered here is READ from the fold
 * (`business/runs/outcome-stats.ts`); nothing is re-derived, so the text report and the `--json`
 * payload can never disagree.
 *
 * Layout follows the sibling CLI commands (`sprint progress`, `runs list`): a headline, then
 * two-space-indented sections, no colour and no box drawing — the CLI output is expected to be
 * piped, grepped and diffed. The TUI owns the rendered-with-theme surface.
 */

import type {
  AttemptsToDoneBucket,
  DimensionFailureCount,
  EscalationRung,
  OutcomeRollup,
  OutcomeStats,
  PlateauSourceKey,
  PlateauStats,
  SprintOutcomeRollup,
} from '@src/business/runs/outcome-stats.ts';
import type { TaskStatus } from '@src/domain/entity/task.ts';

/** Terminal states first — the post-mortem question is "how did tasks END". */
const STATUS_ORDER: readonly TaskStatus[] = ['done', 'blocked', 'in_progress', 'todo'];

const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  done: 'done',
  blocked: 'blocked',
  in_progress: 'in progress',
  todo: 'todo',
};

/** Ladder order, cheapest rung first — mirrors the order the escalation decision climbs them. */
const RUNG_ORDER: readonly EscalationRung[] = ['model', 'effort', 'evaluator-effort', 'nudge', 'best-of-n'];

const PLATEAU_SOURCE_ORDER: readonly PlateauSourceKey[] = ['threshold', 'diversity', 'entropy', 'unspecified'];

/** The histogram tail is long and low-signal; the head is what a post-mortem acts on. */
const TOP_DIMENSIONS = 8;

const LABEL_WIDTH = 15;

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const key = (text: string): string => `  ${text.padEnd(LABEL_WIDTH)}`;

const count = (n: number, singular: string): string => `${String(n)} ${singular}${n === 1 ? '' : 's'}`;

const num = (n: number, width: number): string => String(n).padStart(width);

const headline = (stats: OutcomeStats): string =>
  `Harness outcomes — ${count(stats.sprintCount, 'sprint')} · ${count(stats.totals.taskCount, 'task')}`;

const renderOutcomes = (rollup: OutcomeRollup): readonly string[] => {
  const { byStatus, doneClean, doneWithWarning } = rollup.outcomes;
  const lines = ['Outcome mix'];
  for (const status of STATUS_ORDER) {
    const suffix = status === 'done' ? `  (clean ${String(doneClean)} · with warning ${String(doneWithWarning)})` : '';
    lines.push(`${key(STATUS_LABELS[status])}${String(byStatus[status])}${suffix}`);
  }
  return lines;
};

/** The two headline rates, side by side — the numbers a settings change is judged on. */
const renderSummary = (rollup: OutcomeRollup): readonly string[] => {
  const { doneOnFirstAttempt, doneTotal, rate } = rollup.firstPass;
  const criteria = rollup.criteria;
  return [
    'Summary',
    `${key('first pass')}${String(doneOnFirstAttempt)}/${String(doneTotal)} done on attempt 1 (${pct(rate)})`,
    `${key('criteria')}${String(criteria.passed)}/${String(criteria.declared)} passed (${pct(criteria.passRate)}) · ${String(criteria.failed)} failed · ${String(criteria.unknown)} unknown · ${count(criteria.tasksWithVerdicts, 'task')} graded`,
  ];
};

const renderAttempts = (buckets: readonly AttemptsToDoneBucket[]): readonly string[] => {
  const lines = ['Attempts to done'];
  if (buckets.length === 0) {
    lines.push('  (no done task carries an attempt count yet)');
    return lines;
  }
  for (const bucket of buckets) {
    lines.push(`${key(count(bucket.attempts, 'attempt'))}${count(bucket.tasks, 'task')}`);
  }
  return lines;
};

const renderPlateau = (plateau: PlateauStats): readonly string[] => {
  const lines = [
    'Plateau',
    `${key('tasks')}${count(plateau.tasksWithPlateau, 'task')} (${pct(plateau.taskRate)})`,
    `${key('attempts')}${String(plateau.attemptsWithPlateau)}`,
  ];
  // Detector attribution only — a source with no hits is noise, and `unspecified` only appears
  // for warnings persisted before the detector was stamped.
  for (const source of PLATEAU_SOURCE_ORDER) {
    const hits = plateau.bySource[source];
    if (hits > 0) lines.push(`${key(source)}${String(hits)}`);
  }
  return lines;
};

const RUNG_HEADER = `  ${'rung'.padEnd(18)}granted  resolved  fell-through  unsettled`;

const renderEscalation = (rollup: OutcomeRollup): readonly string[] => {
  const rows = RUNG_ORDER.filter((rung) => rollup.escalation[rung].granted > 0);
  const lines = ['Escalation rungs'];
  if (rows.length === 0) {
    lines.push('  (no escalation rung fired)');
    return lines;
  }
  lines.push(RUNG_HEADER);
  for (const rung of rows) {
    const efficacy = rollup.escalation[rung];
    lines.push(
      `  ${rung.padEnd(18)}${num(efficacy.granted, 7)}${num(efficacy.resolved, 10)}${num(efficacy.fellThrough, 14)}${num(efficacy.unsettled, 11)}`
    );
  }
  return lines;
};

const renderDimensions = (dimensions: readonly DimensionFailureCount[]): readonly string[] => {
  const lines = ['Failed dimensions'];
  if (dimensions.length === 0) {
    lines.push('  (no plateau recorded a failed dimension)');
    return lines;
  }
  for (const entry of dimensions.slice(0, TOP_DIMENSIONS)) {
    lines.push(`${key(entry.dimension)}${String(entry.count)}`);
  }
  const hidden = dimensions.length - TOP_DIMENSIONS;
  if (hidden > 0) lines.push(`  … ${count(hidden, 'more dimension')} (use --json for the full histogram)`);
  return lines;
};

const sprintLine = (entry: SprintOutcomeRollup): string => {
  const { rollup } = entry;
  const parts = [
    count(rollup.taskCount, 'task'),
    `${String(rollup.outcomes.byStatus.done)} done`,
    `${String(rollup.outcomes.byStatus.blocked)} blocked`,
    `first-pass ${pct(rollup.firstPass.rate)}`,
    `plateau ${pct(rollup.plateau.taskRate)}`,
  ];
  return `  ${entry.sprintName} (${entry.sprintId})\n    ${parts.join(' · ')}`;
};

const renderBySprint = (bySprint: readonly SprintOutcomeRollup[]): readonly string[] => [
  'By sprint',
  ...bySprint.map(sprintLine),
];

/**
 * The full report. Sections are separated by a blank line; the trailing newline is included so
 * callers can `process.stdout.write(render(...))` directly. The per-sprint breakdown is omitted
 * for a single-sprint scope, where it would just restate the totals.
 *
 * @public
 */
export const renderOutcomeStats = (stats: OutcomeStats): string => {
  const sections: ReadonlyArray<readonly string[]> = [
    [headline(stats)],
    renderSummary(stats.totals),
    renderOutcomes(stats.totals),
    renderAttempts(stats.totals.attemptsToDone),
    renderPlateau(stats.totals.plateau),
    renderEscalation(stats.totals),
    renderDimensions(stats.totals.failedDimensions),
    ...(stats.bySprint.length > 1 ? [renderBySprint(stats.bySprint)] : []),
  ];
  return `${sections.map((section) => section.join('\n')).join('\n\n')}\n`;
};
