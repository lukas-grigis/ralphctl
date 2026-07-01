import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { bootstrapCli } from '@src/application/ui/cli/bootstrap.ts';
import {
  formatBytes,
  formatRelativeAge,
  groupByFlow,
  listRuns,
  parseDuration,
  type RunEntry,
} from '@src/integration/ai/runs/_engine/run-enumeration.ts';

interface ListOpts {
  readonly flow?: string;
}

interface PruneOpts {
  readonly olderThan?: string;
  readonly keepLast?: string;
  readonly flow?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

interface PruneFilters {
  readonly olderThanMs: number | undefined;
  readonly keepLast: number | undefined;
}

type PruneFiltersResult = ({ readonly ok: true } & PruneFilters) | { readonly ok: false };

type ScopedRunsResult =
  { readonly ok: true; readonly grouped: ReadonlyMap<string, readonly RunEntry[]> } | { readonly ok: false };

type FlowFilterResult = { readonly ok: true; readonly flowFilter: string | undefined } | { readonly ok: false };

/**
 * Register the `runs` command group — inspection + tidy-up for per-run forensic artifacts
 * under `<dataRoot>/runs/<flow>/<run-id>/`.
 *
 *   ralphctl runs list   [--flow <name>]
 *   ralphctl runs prune  [--older-than <dur>] [--keep-last <n>] [--flow <name>]
 *                        [--dry-run] [--yes|-y]
 *
 * Lifecycle of the runs tree is user-managed (`rm -rf` at will, no auto-GC). This surface
 * gives operators a safer alternative to `rm -rf` — with filters, a confirm prompt, dry-run,
 * and per-failure tolerance so a single permission-denied entry doesn't strand the rest.
 */
export const registerRunsCommand = (program: Command): void => {
  const runs = program.command('runs').description('inspect and prune per-run forensic artifacts');

  runs
    .command('list')
    .description('list per-run forensic artifacts grouped by flow')
    .option('-f, --flow <name>', 'restrict the listing to a single flow')
    .action(async (opts: ListOpts) => {
      await runListCommand(opts);
    });

  runs
    .command('prune')
    .description('delete per-run forensic artifacts (filters required unless invoked interactively)')
    .option('--older-than <duration>', 'delete runs older than this (h / d / w suffix, e.g. 7d)')
    .option('--keep-last <n>', 'retain the N most-recent runs per flow')
    .option('-f, --flow <name>', 'restrict pruning to a single flow')
    .option('--dry-run', 'list candidates without deleting (wins over --yes)')
    .option('-y, --yes', 'skip the interactive y/N confirmation')
    .action(async (opts: PruneOpts) => {
      await runPruneCommand(opts);
    });
};

const runListCommand = async (opts: ListOpts): Promise<void> => {
  const { storage } = await bootstrapCli();
  const result = await listRuns(storage.runsRoot);
  if (!result.ok) {
    process.stderr.write(`error: ${result.error.message}\n`);
    process.exit(1);
    return;
  }
  const entries = opts.flow !== undefined ? result.value.filter((r) => r.flow === opts.flow) : result.value;
  if (entries.length === 0) {
    if (opts.flow !== undefined) {
      process.stdout.write(`no runs for flow '${opts.flow}' under ${String(storage.runsRoot)}\n`);
    } else {
      process.stdout.write(`no runs yet under ${String(storage.runsRoot)}\n`);
    }
    return;
  }
  const groups = groupByFlow(entries);
  const now = new Date();
  let grandTotalBytes = 0;
  let grandTotalRuns = 0;
  for (const [flow, runs] of groups) {
    const flowBytes = runs.reduce((acc, r) => acc + r.sizeBytes, 0);
    grandTotalBytes += flowBytes;
    grandTotalRuns += runs.length;
    process.stdout.write(
      `${flow}  (${String(runs.length)} run${runs.length === 1 ? '' : 's'}, ${formatBytes(flowBytes)})\n`
    );
    for (const run of runs) {
      process.stdout.write(`  ${run.runId}  ${formatRelativeAge(run.timestamp, now)}  ${formatBytes(run.sizeBytes)}\n`);
    }
  }
  process.stdout.write(
    `total: ${String(grandTotalRuns)} run${grandTotalRuns === 1 ? '' : 's'}, ${formatBytes(grandTotalBytes)}\n`
  );
};

const runPruneCommand = async (opts: PruneOpts): Promise<void> => {
  // No-args interactive path: every flag is unset → run the interactive picker (only on a TTY).
  const noFlags =
    opts.olderThan === undefined &&
    opts.keepLast === undefined &&
    opts.flow === undefined &&
    opts.dryRun !== true &&
    opts.yes !== true;
  if (noFlags) {
    await runInteractivePrune();
    return;
  }

  const filters = parsePruneFilters(opts);
  if (!filters.ok) return;

  const scopedResult = await resolveScopedRuns(opts.flow);
  if (!scopedResult.ok) return;

  if (filters.olderThanMs === undefined && filters.keepLast === undefined) {
    process.stderr.write(
      'error: --older-than or --keep-last is required (or invoke `ralphctl runs prune` with no flags for the interactive picker)\n'
    );
    process.exit(1);
    return;
  }

  const candidates = computeAndAnnouncePruneCandidates(scopedResult.grouped, {
    olderThanMs: filters.olderThanMs,
    keepLast: filters.keepLast,
  });
  if (candidates === undefined) return;

  if (opts.dryRun === true) {
    return;
  }

  if (opts.yes !== true) {
    const confirmed = await confirmNonInteractivePrune(candidates.length);
    if (!confirmed) return;
  }

  await performPrune(candidates);
};

/** Validate `--older-than` / `--keep-last`, reporting + exiting on the first malformed value. */
const parsePruneFilters = (opts: PruneOpts): PruneFiltersResult => {
  let olderThanMs: number | undefined;
  if (opts.olderThan !== undefined) {
    const parsed = parseDuration(opts.olderThan);
    if (!parsed.ok) {
      process.stderr.write(`error: ${parsed.error.message}\n`);
      process.exit(1);
      return { ok: false };
    }
    olderThanMs = parsed.value;
  }

  let keepLast: number | undefined;
  if (opts.keepLast !== undefined) {
    const parsed = Number(opts.keepLast);
    if (!Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write(`error: --keep-last must be a non-negative integer\n`);
      process.exit(1);
      return { ok: false };
    }
    keepLast = parsed;
  }

  return { ok: true, olderThanMs, keepLast };
};

/** List runs, verify the requested `--flow` exists, and group the scoped entries by flow. */
const resolveScopedRuns = async (flow: string | undefined): Promise<ScopedRunsResult> => {
  const { storage } = await bootstrapCli();
  const result = await listRuns(storage.runsRoot);
  if (!result.ok) {
    process.stderr.write(`error: ${result.error.message}\n`);
    process.exit(1);
    return { ok: false };
  }

  const allEntries = result.value;

  if (flow !== undefined) {
    const flowExists = allEntries.some((r) => r.flow === flow);
    if (!flowExists) {
      process.stderr.write(`error: no such flow '${flow}' under ${String(storage.runsRoot)}\n`);
      process.exit(1);
      return { ok: false };
    }
  }

  const scoped = flow !== undefined ? allEntries.filter((r) => r.flow === flow) : allEntries;
  return { ok: true, grouped: groupByFlow(scoped) };
};

/**
 * Shared tail of both prune paths: select candidates, surface unknown-timestamp warnings, and
 * print the summary. Returns `undefined` when there is nothing to prune (caller should stop).
 */
const computeAndAnnouncePruneCandidates = (
  grouped: ReadonlyMap<string, readonly RunEntry[]>,
  filters: PruneFilters
): readonly RunEntry[] | undefined => {
  const { candidates, unknownStampWarnings } = selectCandidates(grouped, filters);

  for (const warning of unknownStampWarnings) {
    process.stdout.write(`warning: skipping run with non-conforming dir name (no timestamp): ${warning}\n`);
  }

  if (candidates.length === 0) {
    process.stdout.write('nothing to prune\n');
    return undefined;
  }

  printCandidateSummary(candidates);
  return candidates;
};

/** Non-interactive `--yes`-less confirm: refuse on a non-TTY stdin, otherwise prompt y/N. */
const confirmNonInteractivePrune = async (count: number): Promise<boolean> => {
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'error: refusing to delete without confirmation on a non-TTY stdin — re-run with --yes to bypass, or --dry-run to list candidates only\n'
    );
    process.exit(1);
    return false;
  }
  const confirmed = await confirmYesNo(`delete ${String(count)} run${count === 1 ? '' : 's'}? [y/N] `);
  if (!confirmed) {
    process.stdout.write('aborted\n');
    return false;
  }
  return true;
};

const runInteractivePrune = async (): Promise<void> => {
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'error: interactive prune requires a TTY — supply --older-than or --keep-last (plus --yes / --dry-run) on non-interactive stdin\n'
    );
    process.exit(1);
    return;
  }
  const { storage } = await bootstrapCli();
  const listed = await listRuns(storage.runsRoot);
  if (!listed.ok) {
    process.stderr.write(`error: ${listed.error.message}\n`);
    process.exit(1);
    return;
  }
  if (listed.value.length === 0) {
    process.stdout.write(`no runs to prune under ${String(storage.runsRoot)}\n`);
    return;
  }
  const groups = groupByFlow(listed.value);
  const flows = Array.from(groups.keys());
  printRunsOverview(groups);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const filterChoice = await promptPruneFilterChoice(rl);
    if (!filterChoice.ok) return;

    const flowChoice = await promptFlowFilterChoice(rl, flows);
    if (!flowChoice.ok) return;

    const scoped =
      flowChoice.flowFilter !== undefined ? listed.value.filter((r) => r.flow === flowChoice.flowFilter) : listed.value;
    const grouped = groupByFlow(scoped);
    const candidates = computeAndAnnouncePruneCandidates(grouped, {
      olderThanMs: filterChoice.olderThanMs,
      keepLast: filterChoice.keepLast,
    });
    if (candidates === undefined) return;

    const ok = (
      await question(rl, `delete ${String(candidates.length)} run${candidates.length === 1 ? '' : 's'}? [y/N] `)
    ).trim();
    if (!isYes(ok)) {
      process.stdout.write('aborted\n');
      return;
    }
    await performPrune(candidates);
  } finally {
    rl.close();
  }
};

const printRunsOverview = (groups: ReadonlyMap<string, readonly RunEntry[]>): void => {
  process.stdout.write('current runs:\n');
  for (const [flow, runs] of groups) {
    const flowBytes = runs.reduce((acc, r) => acc + r.sizeBytes, 0);
    process.stdout.write(
      `  ${flow}  (${String(runs.length)} run${runs.length === 1 ? '' : 's'}, ${formatBytes(flowBytes)})\n`
    );
  }
  process.stdout.write('\n');
};

/** Prompt for age-vs-keep-last, then the matching follow-up value, validating as it goes. */
const promptPruneFilterChoice = async (rl: ReturnType<typeof createInterface>): Promise<PruneFiltersResult> => {
  const criterion = (await question(rl, 'prune by [1] age threshold or [2] keep-last N? ')).trim();
  if (criterion === '1') {
    const duration = (await question(rl, 'duration (e.g. 7d, 24h, 2w): ')).trim();
    const parsed = parseDuration(duration);
    if (!parsed.ok) {
      process.stderr.write(`error: ${parsed.error.message}\n`);
      process.exit(1);
      return { ok: false };
    }
    return { ok: true, olderThanMs: parsed.value, keepLast: undefined };
  }
  if (criterion === '2') {
    const n = (await question(rl, 'keep last N runs per flow: ')).trim();
    const parsed = Number(n);
    if (!Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write('error: keep-last must be a non-negative integer\n');
      process.exit(1);
      return { ok: false };
    }
    return { ok: true, olderThanMs: undefined, keepLast: parsed };
  }
  process.stderr.write(`error: unrecognised choice '${criterion}' — expected 1 or 2\n`);
  process.exit(1);
  return { ok: false };
};

/** Prompt for an optional flow restriction, validating it against the known flow list. */
const promptFlowFilterChoice = async (
  rl: ReturnType<typeof createInterface>,
  flows: readonly string[]
): Promise<FlowFilterResult> => {
  const flowAnswer = (
    await question(rl, `restrict to a flow? [enter for all, or one of: ${flows.join(', ')}] `)
  ).trim();
  const flowFilter = flowAnswer.length === 0 ? undefined : flowAnswer;
  if (flowFilter !== undefined && !flows.includes(flowFilter)) {
    process.stderr.write(`error: no such flow '${flowFilter}'\n`);
    process.exit(1);
    return { ok: false };
  }
  return { ok: true, flowFilter };
};

/**
 * Per-flow candidate selection. When both criteria are set, a dir qualifies only when it is
 * older than the duration AND not among the N most-recent for its flow. When only one is set,
 * only that criterion gates the dir. Non-conforming dir names (no embedded timestamp) cannot
 * satisfy `--older-than`; they're surfaced via `unknownStampWarnings` so the caller can warn
 * once, and skipped from the age branch but still considered for `--keep-last` ordering
 * (they sort to the tail in groupByFlow).
 */
const selectCandidates = (
  grouped: ReadonlyMap<string, readonly RunEntry[]>,
  filters: PruneFilters
): { readonly candidates: readonly RunEntry[]; readonly unknownStampWarnings: readonly string[] } => {
  const { olderThanMs, keepLast } = filters;
  const candidates: RunEntry[] = [];
  const unknownStampWarnings: string[] = [];
  const nowMs = Date.now();
  for (const [, runsForFlow] of grouped) {
    const keep = buildKeepSet(runsForFlow, keepLast);
    for (const run of runsForFlow) {
      const { qualifies, unknownStamp } = evaluatePruneQualification(run, keep, olderThanMs, nowMs);
      if (unknownStamp) unknownStampWarnings.push(run.path);
      if (qualifies) candidates.push(run);
    }
  }
  return { candidates, unknownStampWarnings };
};

/** The set of run paths to retain under `--keep-last` for one flow's run list. */
const buildKeepSet = (runsForFlow: readonly RunEntry[], keepLast: number | undefined): Set<string> | undefined => {
  if (keepLast === undefined) return undefined;
  const keep = new Set<string>();
  for (const r of runsForFlow.slice(0, keepLast)) keep.add(r.path);
  return keep;
};

/** Age + keep-last gating for one run; `unknownStamp` flags a dir name with no embedded timestamp. */
const evaluatePruneQualification = (
  run: RunEntry,
  keepSet: Set<string> | undefined,
  olderThanMs: number | undefined,
  nowMs: number
): { readonly qualifies: boolean; readonly unknownStamp: boolean } => {
  let ageQualifies = true;
  let unknownStamp = false;
  if (olderThanMs !== undefined) {
    if (run.timestamp === null) {
      unknownStamp = true;
      ageQualifies = false;
    } else {
      ageQualifies = nowMs - run.timestamp.getTime() >= olderThanMs;
    }
  }
  const keepQualifies = keepSet === undefined ? true : !keepSet.has(run.path);
  return { qualifies: ageQualifies && keepQualifies, unknownStamp };
};

const printCandidateSummary = (candidates: readonly RunEntry[]): void => {
  const grouped = groupByFlow(candidates);
  process.stdout.write('candidates:\n');
  let totalBytes = 0;
  for (const [flow, runs] of grouped) {
    const flowBytes = runs.reduce((acc, r) => acc + r.sizeBytes, 0);
    totalBytes += flowBytes;
    process.stdout.write(
      `  ${flow}: ${String(runs.length)} run${runs.length === 1 ? '' : 's'}, ${formatBytes(flowBytes)}\n`
    );
  }
  process.stdout.write(
    `  total: ${String(candidates.length)} run${candidates.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)}\n`
  );
};

const performPrune = async (candidates: readonly RunEntry[]): Promise<void> => {
  const failures: Array<{ readonly path: string; readonly reason: string }> = [];
  let freedBytes = 0;
  let freedCount = 0;
  for (const candidate of candidates) {
    try {
      await fs.rm(String(candidate.path), { recursive: true, force: false });
      freedBytes += candidate.sizeBytes;
      freedCount += 1;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      failures.push({ path: String(candidate.path), reason });
    }
  }
  process.stdout.write(
    `pruned ${String(freedCount)} run${freedCount === 1 ? '' : 's'}, freed ${formatBytes(freedBytes)}\n`
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`  failed: ${failure.path} — ${failure.reason}\n`);
    }
    process.stderr.write(
      `error: ${String(failures.length)} run${failures.length === 1 ? '' : 's'} could not be deleted\n`
    );
    process.exit(1);
  }
};

const question = (rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });

const confirmYesNo = async (prompt: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await question(rl, prompt);
    return isYes(answer.trim());
  } finally {
    rl.close();
  }
};

const isYes = (answer: string): boolean => {
  const lower = answer.toLowerCase();
  return lower === 'y' || lower === 'yes';
};
