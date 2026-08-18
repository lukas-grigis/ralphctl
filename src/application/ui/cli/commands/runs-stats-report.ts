/**
 * Human-readable projection of the harness outcome rollup. Pure: `OutcomeStats` in, text out —
 * no clock, no filesystem, no `process.stdout`. Every number rendered here is READ from the fold
 * (`business/runs/outcome-stats.ts`); nothing is re-derived, so the text report and the `--json`
 * payload can never disagree.
 *
 * Layout follows the sibling CLI commands (`sprint progress`, `runs list`): a headline, then
 * two-space-indented sections, no colour and no box drawing — the CLI output is expected to be
 * piped, grepped and diffed. The TUI owns the rendered-with-theme surface.
 *
 * ## Two denominators
 *
 * Task-based rates (outcome mix, first-pass, plateau incidence, escalation) and attempt-based
 * rates (attribution, warnings, aborts) sit in the same report and are NOT comparable. Every
 * section therefore names its own denominator in its header — `(of N tasks)` vs `(of N attempts)`
 * — and the two summary rates spell theirs out inline. An unlabelled percentage here would be
 * read as comparable with the one above it, which is the failure mode this layout exists to stop.
 */

import type {
  AbortCauseKey,
  AbortStats,
  AttributionKey,
  AttributionStats,
  DimensionFailureCount,
  EscalationRung,
  OutcomeRollup,
  OutcomeStats,
  PlateauSourceKey,
  PlateauStats,
  SprintOutcomeRollup,
  WarningKindKey,
  WarningStats,
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

/**
 * Severity first — the row an operator must not miss leads the block. Declaration order IS render
 * order (see {@link ATTRIBUTION_ORDER}), and the `Record` is exhaustive over the union, so a new
 * verdict cannot reach the fold without also being given a slot here.
 *
 * `unspecified` is the canonical key (and stays that way in `--json`); `unattributed` is the
 * word an operator reads faster. Presentation affordance only.
 */
const ATTRIBUTION_LABEL: Readonly<Record<AttributionKey, string>> = {
  regressed: 'regressed',
  'baseline-broken': 'baseline-broken',
  'fixed-baseline': 'fixed-baseline',
  clean: 'clean',
  unspecified: 'unattributed',
};

const ATTRIBUTION_ORDER = Object.keys(ATTRIBUTION_LABEL) as readonly AttributionKey[];

/** Costliest failure mode first; `unknown` last, where the legacy records land. */
const WARNING_ORDER: readonly WarningKindKey[] = [
  'verify-failed',
  'crashed',
  'malformed',
  'budget-exhausted',
  'plateau',
  'unknown',
];

const ABORT_ORDER: readonly AbortCauseKey[] = [
  'rate-limit-exhausted',
  'watchdog-killed',
  'process-crash',
  'sigterm',
  'user-cancel',
  'unknown',
];

/** The histogram tail is long and low-signal; the head is what a post-mortem acts on. */
const TOP_DIMENSIONS = 8;

const LABEL_WIDTH = 15;

/** The taxonomy keys are longer than the legacy sections' (`rate-limit-exhausted` is 20). */
const TAXONOMY_LABEL_WIDTH = 22;

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const keyAt = (text: string, width: number): string => `  ${text.padEnd(width)}`;

const key = (text: string): string => keyAt(text, LABEL_WIDTH);

const taxonomyKey = (text: string): string => keyAt(text, TAXONOMY_LABEL_WIDTH);

/**
 * The nonzero rows of one taxonomy block, curated order first and then any key the block carries
 * that the order array was never taught about. The fold's zero records are exhaustive over their
 * unions, but a bare `readonly K[]` ordering cannot be — without the tail a warning kind or abort
 * cause added later would be counted by the fold and then silently vanish from the report, which
 * is precisely the blind spot these sections exist to close.
 */
const taxonomyRows = (counts: Readonly<Record<string, number>>, order: readonly string[]): readonly string[] => {
  const tail = Object.keys(counts).filter((candidate) => !order.includes(candidate));
  return [...order, ...tail]
    .filter((taxon) => (counts[taxon] ?? 0) > 0)
    .map((taxon) => `${taxonomyKey(taxon)}${String(counts[taxon] ?? 0)}`);
};

const count = (n: number, singular: string): string => `${String(n)} ${singular}${n === 1 ? '' : 's'}`;

const num = (n: number, width: number): string => String(n).padStart(width);

/** `(of N tasks)` / `(of N attempts)` — the denominator label every section header carries. */
const denominator = (n: number, unit: string): string => `(of ${count(n, unit)})`;

const headline = (stats: OutcomeStats): string =>
  `Harness outcomes — ${count(stats.sprintCount, 'sprint')} · ${count(stats.totals.taskCount, 'task')} · ${count(stats.totals.attemptCount, 'attempt')}`;

const renderOutcomes = (rollup: OutcomeRollup): readonly string[] => {
  const { byStatus, doneClean, doneWithWarning } = rollup.outcomes;
  const lines = [`Outcome mix ${denominator(rollup.taskCount, 'task')}`];
  for (const status of STATUS_ORDER) {
    const suffix = status === 'done' ? `  (clean ${String(doneClean)} · with warning ${String(doneWithWarning)})` : '';
    lines.push(`${key(STATUS_LABELS[status])}${String(byStatus[status])}${suffix}`);
  }
  return lines;
};

/**
 * The severity headline. Spelled out rather than shown as a bare percentage because its
 * denominator is neither the task count nor the attempt count: attempts with no derivable verdict
 * (no verify script, pre-verify spawn-error) are excluded, so quoting them as `attributed` is what
 * keeps the rate honest in a repo that never runs a check.
 */
const regressionLine = (attribution: AttributionStats): string => {
  if (attribution.attributed === 0) return `${key('regressions')}— (no attempt carries an attribution verdict)`;
  const broke = `${count(attribution.byVerdict.regressed, 'attempt')} broke a green baseline`;
  return `${key('regressions')}${broke} (${pct(attribution.regressionRate)} of ${count(attribution.attributed, 'attributed attempt')})`;
};

/** The headline rates, stacked — the numbers a settings change is judged on. */
const renderSummary = (rollup: OutcomeRollup): readonly string[] => {
  const { doneOnFirstAttempt, doneTotal, rate } = rollup.firstPass;
  const criteria = rollup.criteria;
  return [
    'Summary',
    `${key('first pass')}${String(doneOnFirstAttempt)}/${String(doneTotal)} done on attempt 1 (${pct(rate)}) — of ${count(doneTotal, 'done task')}`,
    regressionLine(rollup.attribution),
    `${key('criteria')}${String(criteria.passed)}/${String(criteria.declared)} passed (${pct(criteria.passRate)}) · ${String(criteria.failed)} failed · ${String(criteria.unknown)} unknown · ${count(criteria.tasksWithVerdicts, 'task')} graded`,
  ];
};

const renderAttempts = (rollup: OutcomeRollup): readonly string[] => {
  const buckets = rollup.attemptsToDone;
  const lines = [`Attempts to done ${denominator(rollup.firstPass.doneTotal, 'done task')}`];
  if (buckets.length === 0) {
    lines.push('  (no done task carries an attempt count yet)');
    return lines;
  }
  for (const bucket of buckets) {
    lines.push(`${key(count(bucket.attempts, 'attempt'))}${count(bucket.tasks, 'task')}`);
  }
  return lines;
};

const renderPlateau = (plateau: PlateauStats, taskCount: number, attemptCount: number): readonly string[] => {
  const lines = [
    'Plateau',
    `${key('tasks')}${count(plateau.tasksWithPlateau, 'task')} (${pct(plateau.taskRate)}) — of ${count(taskCount, 'task')}`,
    `${key('attempts')}${String(plateau.attemptsWithPlateau)} — of ${count(attemptCount, 'attempt')}`,
  ];
  // Detector attribution only — a source with no hits is noise, and `unspecified` only appears
  // for warnings persisted before the detector was stamped.
  for (const source of PLATEAU_SOURCE_ORDER) {
    const hits = plateau.bySource[source];
    if (hits > 0) lines.push(`${key(source)}${String(hits)}`);
  }
  return lines;
};

/**
 * The regression taxonomy. `regressed` renders even at zero — a rollup that silently omits its
 * severity headline is exactly the blind spot this section exists to close — but only once some
 * attempt carries a verdict at all; with nothing attributed, a `0` would read as "no regressions"
 * when the truth is "no evidence either way".
 */
const renderAttribution = (attribution: AttributionStats, attemptCount: number): readonly string[] => {
  const lines = [`Attribution ${denominator(attemptCount, 'attempt')}`];
  if (attribution.attributed === 0) {
    lines.push('  (no attempt carries an attribution verdict)');
    return lines;
  }
  for (const verdict of ATTRIBUTION_ORDER) {
    const hits = attribution.byVerdict[verdict];
    if (hits > 0 || verdict === 'regressed') lines.push(`${taxonomyKey(ATTRIBUTION_LABEL[verdict])}${String(hits)}`);
  }
  return lines;
};

/** Every attempt-terminating warning by kind — what `done (with warning N)` collapses. */
const renderWarnings = (warnings: WarningStats, attemptCount: number): readonly string[] => {
  const lines = [`Warnings ${denominator(attemptCount, 'attempt')}`];
  if (warnings.attemptsWithWarning === 0) {
    lines.push('  (no attempt carried a warning)');
    return lines;
  }
  return [...lines, ...taxonomyRows(warnings.byKind, WARNING_ORDER)];
};

/** Why aborted attempts died — an operator Ctrl-C is not a rate-limit wall. */
const renderAborts = (aborts: AbortStats, attemptCount: number): readonly string[] => {
  const lines = [`Aborts ${denominator(attemptCount, 'attempt')}`];
  if (aborts.attemptsAborted === 0) {
    lines.push('  (no attempt was aborted)');
    return lines;
  }
  return [...lines, ...taxonomyRows(aborts.byCause, ABORT_ORDER)];
};

const RUNG_HEADER = `  ${'rung'.padEnd(18)}granted  resolved  fell-through  unsettled`;

const renderEscalation = (rollup: OutcomeRollup): readonly string[] => {
  const rows = RUNG_ORDER.filter((rung) => rollup.escalation[rung].granted > 0);
  const lines = [`Escalation rungs ${denominator(rollup.taskCount, 'task')}`];
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
  // Every other field on this line is task-scoped, so the regression flag is too — an attempt
  // count sitting between `1 blocked` and `plateau 50.0%` would read as a task count anyway.
  const regressed = rollup.attribution.tasksWithRegression;
  const parts = [
    count(rollup.taskCount, 'task'),
    `${String(rollup.outcomes.byStatus.done)} done`,
    `${String(rollup.outcomes.byStatus.blocked)} blocked`,
    `first-pass ${pct(rollup.firstPass.rate)}`,
    `plateau ${pct(rollup.plateau.taskRate)}`,
    // Appended only when it happened — the line is already five fields wide.
    ...(regressed > 0 ? [`${String(regressed)} regressed`] : []),
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
    renderAttempts(stats.totals),
    renderPlateau(stats.totals.plateau, stats.totals.taskCount, stats.totals.attemptCount),
    renderAttribution(stats.totals.attribution, stats.totals.attemptCount),
    renderWarnings(stats.totals.warnings, stats.totals.attemptCount),
    renderAborts(stats.totals.aborts, stats.totals.attemptCount),
    renderEscalation(stats.totals),
    renderDimensions(stats.totals.failedDimensions),
    ...(stats.bySprint.length > 1 ? [renderBySprint(stats.bySprint)] : []),
  ];
  return `${sections.map((section) => section.join('\n')).join('\n\n')}\n`;
};
