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

  let olderThanMs: number | undefined;
  if (opts.olderThan !== undefined) {
    const parsed = parseDuration(opts.olderThan);
    if (!parsed.ok) {
      process.stderr.write(`error: ${parsed.error.message}\n`);
      process.exit(1);
      return;
    }
    olderThanMs = parsed.value;
  }

  let keepLast: number | undefined;
  if (opts.keepLast !== undefined) {
    const parsed = Number(opts.keepLast);
    if (!Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write(`error: --keep-last must be a non-negative integer\n`);
      process.exit(1);
      return;
    }
    keepLast = parsed;
  }

  const { storage } = await bootstrapCli();
  const result = await listRuns(storage.runsRoot);
  if (!result.ok) {
    process.stderr.write(`error: ${result.error.message}\n`);
    process.exit(1);
    return;
  }

  const allEntries = result.value;

  if (opts.flow !== undefined) {
    const flowExists = allEntries.some((r) => r.flow === opts.flow);
    if (!flowExists) {
      process.stderr.write(`error: no such flow '${opts.flow}' under ${String(storage.runsRoot)}\n`);
      process.exit(1);
      return;
    }
  }

  const scoped = opts.flow !== undefined ? allEntries.filter((r) => r.flow === opts.flow) : allEntries;
  const grouped = groupByFlow(scoped);

  if (olderThanMs === undefined && keepLast === undefined) {
    process.stderr.write(
      'error: --older-than or --keep-last is required (or invoke `ralphctl runs prune` with no flags for the interactive picker)\n'
    );
    process.exit(1);
    return;
  }

  const { candidates, unknownStampWarnings } = selectCandidates(grouped, { olderThanMs, keepLast });

  for (const warning of unknownStampWarnings) {
    process.stdout.write(`warning: skipping run with non-conforming dir name (no timestamp): ${warning}\n`);
  }

  if (candidates.length === 0) {
    process.stdout.write('nothing to prune\n');
    return;
  }

  printCandidateSummary(candidates);

  if (opts.dryRun === true) {
    return;
  }

  if (opts.yes !== true) {
    if (process.stdin.isTTY !== true) {
      process.stderr.write(
        'error: refusing to delete without confirmation on a non-TTY stdin — re-run with --yes to bypass, or --dry-run to list candidates only\n'
      );
      process.exit(1);
      return;
    }
    const confirmed = await confirmYesNo(
      `delete ${String(candidates.length)} run${candidates.length === 1 ? '' : 's'}? [y/N] `
    );
    if (!confirmed) {
      process.stdout.write('aborted\n');
      return;
    }
  }

  await performPrune(candidates);
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
  process.stdout.write('current runs:\n');
  for (const [flow, runs] of groups) {
    const flowBytes = runs.reduce((acc, r) => acc + r.sizeBytes, 0);
    process.stdout.write(
      `  ${flow}  (${String(runs.length)} run${runs.length === 1 ? '' : 's'}, ${formatBytes(flowBytes)})\n`
    );
  }
  process.stdout.write('\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const criterion = (await question(rl, 'prune by [1] age threshold or [2] keep-last N? ')).trim();
    let olderThanMs: number | undefined;
    let keepLast: number | undefined;
    if (criterion === '1') {
      const duration = (await question(rl, 'duration (e.g. 7d, 24h, 2w): ')).trim();
      const parsed = parseDuration(duration);
      if (!parsed.ok) {
        process.stderr.write(`error: ${parsed.error.message}\n`);
        process.exit(1);
        return;
      }
      olderThanMs = parsed.value;
    } else if (criterion === '2') {
      const n = (await question(rl, 'keep last N runs per flow: ')).trim();
      const parsed = Number(n);
      if (!Number.isInteger(parsed) || parsed < 0) {
        process.stderr.write('error: keep-last must be a non-negative integer\n');
        process.exit(1);
        return;
      }
      keepLast = parsed;
    } else {
      process.stderr.write(`error: unrecognised choice '${criterion}' — expected 1 or 2\n`);
      process.exit(1);
      return;
    }
    const flowAnswer = (
      await question(rl, `restrict to a flow? [enter for all, or one of: ${flows.join(', ')}] `)
    ).trim();
    const flowFilter = flowAnswer.length === 0 ? undefined : flowAnswer;
    if (flowFilter !== undefined && !flows.includes(flowFilter)) {
      process.stderr.write(`error: no such flow '${flowFilter}'\n`);
      process.exit(1);
      return;
    }

    const scoped = flowFilter !== undefined ? listed.value.filter((r) => r.flow === flowFilter) : listed.value;
    const grouped = groupByFlow(scoped);
    const { candidates, unknownStampWarnings } = selectCandidates(grouped, { olderThanMs, keepLast });
    for (const warning of unknownStampWarnings) {
      process.stdout.write(`warning: skipping run with non-conforming dir name (no timestamp): ${warning}\n`);
    }
    if (candidates.length === 0) {
      process.stdout.write('nothing to prune\n');
      return;
    }
    printCandidateSummary(candidates);
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
  filters: { readonly olderThanMs: number | undefined; readonly keepLast: number | undefined }
): { readonly candidates: readonly RunEntry[]; readonly unknownStampWarnings: readonly string[] } => {
  const { olderThanMs, keepLast } = filters;
  const candidates: RunEntry[] = [];
  const unknownStampWarnings: string[] = [];
  const nowMs = Date.now();
  for (const [, runsForFlow] of grouped) {
    let keep: Set<string> | undefined;
    if (keepLast !== undefined) {
      keep = new Set<string>();
      for (const r of runsForFlow.slice(0, keepLast)) keep.add(r.path);
    }
    for (const run of runsForFlow) {
      let ageQualifies = true;
      if (olderThanMs !== undefined) {
        if (run.timestamp === null) {
          unknownStampWarnings.push(run.path);
          ageQualifies = false;
        } else {
          ageQualifies = nowMs - run.timestamp.getTime() >= olderThanMs;
        }
      }
      const keepQualifies = keep === undefined ? true : !keep.has(run.path);
      if (ageQualifies && keepQualifies) candidates.push(run);
    }
  }
  return { candidates, unknownStampWarnings };
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
