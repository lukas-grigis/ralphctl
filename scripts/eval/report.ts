import type { EvalFlow } from './fixture-schema.ts';
import { groupItems, isComplete } from './metrics.ts';
import { itemScore, kSufficiency } from './stats.ts';
import type { ComparisonRow, MetricRow, ResultsFile, UsageSummary } from './types.ts';

/**
 * Results → `summary.md` text. Pure — `pnpm eval report` re-renders it offline from `results.json`
 * files, spending no tokens.
 */

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const signedPct = (x: number): string =>
  Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pp` : 'n/a';
const num = (x: number | null, digits = 0): string => (x === null ? 'n/a' : x.toFixed(digits));

/** The CI cell: interval, or the degenerate note when every item sits at 0 / 100% (SE = 0). */
const ciCell = (row: MetricRow): string => {
  if (row.n < 2) return 'n/a (fewer than 2 items)';
  if (row.ci !== null) return `[${pct(row.ci[0])}, ${pct(row.ci[1])}]${row.approx ? ' (approx)' : ''}`;
  if (row.se === 0 || row.mean === 0 || row.mean === 1) {
    return `all ${String(row.n)} at ${pct(row.mean)} — CLT CI degenerate`;
  }
  return 'n/a (fewer than 2 items)';
};

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];

const metricTable = (flow: string, results: ResultsFile): string[] => {
  const byArm = results.metrics[flow] ?? {};
  const rows = Object.entries(byArm).flatMap(([arm, metrics]) =>
    metrics.map((m) => [m.name, arm, pct(m.mean), ciCell(m), String(m.n)])
  );
  return table(['metric', 'arm', 'mean', '95% CI', 'n'], rows);
};

const usageLine = (u: UsageSummary): string =>
  `${String(u.trials)} trials · tokens in ${num(u.inputTokens)} / cache read ${num(u.cacheReadTokens)} / cache write ${num(u.cacheCreationTokens)} / out ${num(u.outputTokens)} (mean ${num(u.meanInputTokens)} / ${num(u.meanCacheReadTokens)} / ${num(u.meanCacheCreationTokens)} / ${num(u.meanOutputTokens)}) · wall ${(u.wallMs / 1000).toFixed(1)}s (mean ${(u.meanWallMs / 1000).toFixed(1)}s)${u.unmeteredTrials > 0 ? ` · ${String(u.unmeteredTrials)} unmetered` : ''}`;

const verdict = (row: ComparisonRow): string =>
  row.detectable ? 'detectable difference' : 'no detectable difference at this N';

const compareTable = (rows: readonly ComparisonRow[]): string[] =>
  table(
    ['flow', 'metric', 'Δ (B − A)', '95% CI', 'verdict', 'MDE', 'n'],
    rows.map((r) => [
      r.flow,
      r.metric,
      signedPct(r.meanDiff),
      `[${signedPct(r.ci[0])}, ${signedPct(r.ci[1])}]${r.approx ? ' (approx)' : ''}`,
      verdict(r),
      Number.isFinite(r.mde) ? `±${pct(r.mde)}` : 'n/a',
      String(r.n),
    ])
  );

/** Capability items every complete arm solved perfectly — nothing left to learn from them (saturation). */
const saturationCandidates = (results: ResultsFile): string[] => {
  const out: string[] = [];
  for (const arm of results.arms) {
    for (const item of groupItems(results.trials, arm.name, results.k)) {
      if (item.tier === 'capability' && isComplete(item) && itemScore(item.trials.map((t) => t.correct)) === 1) {
        out.push(`${arm.name}: ${item.key}`);
      }
    }
  }
  return out;
};

const kSufficiencyLines = (results: ResultsFile): string[] => {
  const lines: string[] = [];
  const flows = Object.keys(results.metrics) as EvalFlow[];
  for (const flow of flows) {
    for (const arm of results.arms) {
      const items = groupItems(results.trials, arm.name, results.k).filter((i) => i.flow === flow && isComplete(i));
      if (items.length < 2) continue;
      const k = items[0]?.expected ?? results.k;
      const s = kSufficiency(
        items.map((i) => i.trials.map((t) => t.correct)),
        k
      );
      lines.push(
        `- ${flow} / ${arm.name}: mean(σ²_i)/K = ${Number.isFinite(s.withinOverK) ? s.withinOverK.toFixed(4) : 'n/a'} beside Var(s) = ${Number.isFinite(s.scoreVariance) ? s.scoreVariance.toFixed(4) : 'n/a'} (K = ${String(k)}). Once the first is ≪ the second, more repeats barely tighten the SE.`
      );
    }
  }
  return lines;
};

export const renderSummary = (results: ResultsFile): string => {
  const lines: string[] = [];
  lines.push(`# Eval run ${results.runId}`, '');
  if (results.dryRun) {
    lines.push(
      '> **DRY RUN** — a scripted fake provider answered; no model was called and no number below is a measurement.',
      ''
    );
  }
  lines.push(
    `- started ${results.startedAt} · finished ${results.finishedAt} · stopped: **${results.stoppedReason}**`,
    `- git ${results.gitSha ?? 'unknown'}${results.gitDirty === true ? ' (dirty)' : ''} · k = ${String(results.k)} · fixture set ${results.fixtureSetHash.slice(0, 12)}`,
    `- arms: ${results.arms.map((a) => `${a.name} (${a.label}${a.templatesDir !== undefined ? `, templates ${a.templatesDir}` : ''})`).join(', ')}`,
    ''
  );

  const b = results.budget;
  lines.push(
    `**Budget:** ${String(b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens)} / ${String(b.maxTokens)} tokens (in ${String(b.inputTokens)}, cache read ${String(b.cacheReadTokens)}, cache write ${String(b.cacheCreationTokens)}, out ${String(b.outputTokens)}) · ${String(b.unmeteredTrials)} unmetered trial(s) · wall ${(b.wallMs / 1000).toFixed(1)}s`,
    ''
  );

  for (const flow of Object.keys(results.metrics)) {
    lines.push(`## ${flow}`, '', ...metricTable(flow, results), '');
    const usage = results.usage[flow] ?? {};
    for (const [arm, u] of Object.entries(usage)) lines.push(`- ${arm}: ${usageLine(u)}`);
    lines.push('');
  }

  if (results.comparison !== undefined && results.comparison.length > 0) {
    lines.push('## Comparison', '', ...compareTable(results.comparison), '');
    lines.push(
      'A difference counts as detectable only when the 95% CI excludes 0; MDE is the smallest effect this N could detect (α = .05, power .8).',
      ''
    );
  }

  if (results.incompleteItems.length > 0) {
    lines.push('## Incomplete items', '', 'Fewer graded trials than expected — left out of stats and pairing.', '');
    for (const i of results.incompleteItems) lines.push(`- ${i}`);
    lines.push('');
  }

  const saturated = saturationCandidates(results);
  if (saturated.length > 0) {
    lines.push('## Saturation candidates', '', 'Capability items with s_i = 1 — retire or harden by hand.', '');
    for (const s of saturated) lines.push(`- ${s}`);
    lines.push('');
  }

  const kLines = kSufficiencyLines(results);
  if (kLines.length > 0) lines.push('## Is k big enough', '', ...kLines, '');

  const bad = results.trials.filter((t) => !t.correct);
  if (bad.length > 0) {
    lines.push(
      '## Trials to read',
      '',
      'Read the transcripts of failures — a fixture or grader bug looks like a model bug until you do.',
      ''
    );
    for (const t of bad) {
      lines.push(
        `- ${t.arm} · ${t.fixtureId}/${t.variant} #${String(t.trialIndex)}${t.graded ? '' : ` (ungraded: ${t.error ?? 'error'})`} → \`${t.artifactDir}\``
      );
    }
    lines.push('');
  }
  if (results.notes.length > 0) lines.push('## Notes', '', ...results.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
};
