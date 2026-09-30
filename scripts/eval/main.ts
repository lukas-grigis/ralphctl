import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiFlowSettings } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyPreset, isPresetName } from '@src/business/settings/presets.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { createShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { ADAPTERS } from './adapters.ts';
import { buildArm, DEFAULT_PRESET, hashTemplatesDir } from './arms.ts';
import { type CommonOptions, type Command, parseCommand, type RunOptions, USAGE } from './cli.ts';
import { loadFixtures } from './load-fixtures.ts';
import { compareArms, summarizeArms } from './metrics.ts';
import { type CheckOutcome, checkFixture } from './oracle.ts';
import { renderSummary } from './report.ts';
import { createResultsStore, readResults } from './results-store.ts';
import { runEval } from './run.ts';
import type { ArmConfig, Fixture, ResolvedRow, ResultsFile } from './types.ts';

/**
 * `pnpm eval <command>` — composition root of the prompt-eval harness. Everything with a decision
 * in it lives in a pure module next to this file; this one only wires real adapters (the shipped
 * provider factory, template loader, git / shell runners) and the process boundary (argv, SIGINT,
 * exit codes). Nothing in `pnpm test`, CI or the build ever reaches it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_FIXTURES_DIR = join(REPO_ROOT, 'evals', 'fixtures');
const RESULTS_ROOT = join(REPO_ROOT, 'evals', 'results');
/** Stop after this many infrastructure errors in a row (engineering judgment). */
const MAX_CONSECUTIVE_ERRORS = 3;

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_PARTIAL = 2;
const EXIT_ABORTED = 130;

const out = (line = ''): void => {
  console.log(line);
};
const err = (line: string): void => {
  console.error(line);
};

const abs = (path: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(path);
  if (!parsed.ok) throw new Error(`not an absolute path: ${path}`);
  return parsed.value;
};

const newRunId = (): string => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

const gitInfo = async (git: ReturnType<typeof createGitRunner>) => {
  const root = abs(REPO_ROOT);
  const sha = await git.run(root, ['rev-parse', 'HEAD']);
  const status = await git.run(root, ['status', '--porcelain']);
  return {
    gitSha: sha.ok && sha.value.exitCode === 0 ? sha.value.stdout.trim() : null,
    gitDirty: status.ok && status.value.exitCode === 0 ? status.value.stdout.trim().length > 0 : null,
  };
};

const loadSelected = async (options: CommonOptions) =>
  loadFixtures(resolve(options.fixturesDir ?? DEFAULT_FIXTURES_DIR), {
    ...(options.flows.length > 0 ? { flows: options.flows } : {}),
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.idGlob !== undefined ? { idGlob: options.idGlob } : {}),
  });

const runCheck = async (
  fixtures: readonly Fixture[],
  deps: { git: ReturnType<typeof createGitRunner>; shell: ReturnType<typeof createShellScriptRunner> },
  signal?: AbortSignal
) => {
  const outcomes: CheckOutcome[] = [];
  for (const fixture of fixtures) {
    const checked = await checkFixture(
      { workspace: { git: deps.git }, oracle: { shell: deps.shell } },
      fixture,
      signal
    );
    if (!checked.ok) return Result.error(checked.error);
    out(`${checked.value.ok ? 'ok  ' : 'FAIL'} ${fixture.flow}/${fixture.id}`);
    for (const line of checked.value.lines) out(`       ${line}`);
    outcomes.push(checked.value);
  }
  return Result.ok(outcomes as readonly CheckOutcome[]);
};

const executeCheck = async (options: CommonOptions): Promise<number> => {
  const loaded = await loadSelected(options);
  if (!loaded.ok) {
    err(loaded.error.message);
    return EXIT_FAILURE;
  }
  const checked = await runCheck(loaded.value.fixtures, { git: createGitRunner(), shell: createShellScriptRunner() });
  if (!checked.ok) {
    err(checked.error.message);
    return EXIT_FAILURE;
  }
  const bad = checked.value.filter((o) => !o.ok).length;
  out(
    `\n${String(checked.value.length - bad)}/${String(checked.value.length)} fixtures proven${bad > 0 ? ` — ${String(bad)} rejected` : ''}`
  );
  return bad > 0 ? EXIT_FAILURE : EXIT_OK;
};

const executeRun = async (
  options: RunOptions,
  candidate?: Extract<Command, { kind: 'compare' }>['candidate']
): Promise<number> => {
  const loaded = await loadSelected(options);
  if (!loaded.ok) {
    err(loaded.error.message);
    return EXIT_FAILURE;
  }
  if (loaded.value.fixtures.length === 0) {
    err('no fixtures matched — nothing to run');
    return EXIT_FAILURE;
  }

  const baselineTemplates = String(defaultTemplatesDir());
  const armA = buildArm({ name: 'baseline', ...options.baseline, templatesDir: baselineTemplates });
  if (!armA.ok) {
    err(armA.error.message);
    return EXIT_FAILURE;
  }
  const arms: ArmConfig[] = [{ ...armA.value, templatesHash: await hashTemplatesDir(baselineTemplates) }];
  if (candidate !== undefined) {
    const templatesDir = candidate.templatesDir !== undefined ? resolve(candidate.templatesDir) : baselineTemplates;
    const armB = buildArm({
      name: 'candidate',
      ...options.baseline,
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
      ...(candidate.provider !== undefined ? { provider: candidate.provider } : {}),
      ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
      templatesDir,
    });
    if (!armB.ok) {
      err(armB.error.message);
      return EXIT_FAILURE;
    }
    const templatesHash = await hashTemplatesDir(templatesDir);
    if (candidate.templatesDir !== undefined && templatesHash === arms[0]?.templatesHash) {
      // Under tsx the baseline is the working tree's prompts, so editing them in place and pointing
      // --candidate-templates at the same directory compares a prompt with itself (A/A) — always
      // "no detectable difference", tokens wasted.
      err(
        `--candidate-templates ${templatesDir} holds the same prompt templates as the baseline (${baselineTemplates}) — ` +
          'an A/A comparison. Put the edited prompts in a separate checkout (git worktree) and point at that.'
      );
      return EXIT_FAILURE;
    }
    arms.push({ ...armB.value, templatesHash });
  }

  const presetName = options.baseline.preset ?? DEFAULT_PRESET;
  const settings = applyPreset(isPresetName(presetName) ? presetName : DEFAULT_PRESET, DEFAULT_SETTINGS);
  const eventBus = createInMemoryEventBus();
  eventBus.subscribe((event) => {
    if (event.type === 'log' && (event.level === 'warn' || event.level === 'error'))
      err(`[${event.level}] ${event.message}`);
  });
  const logger = createEventBusLogger({ eventBus, clock: () => IsoTimestamp.now() });
  const git = createGitRunner();
  const shell = createShellScriptRunner();
  const providers = new Map<string, HeadlessAiProvider>();
  const providerFor = (row: ResolvedRow): HeadlessAiProvider => {
    const key = row.provider;
    let provider = providers.get(key);
    if (provider === undefined) {
      provider = createAiProvider({ row: row as AiFlowSettings, harnessConfig: settings.harness, eventBus });
      providers.set(key, provider);
    }
    return provider;
  };

  const runId = newRunId();
  const runDir = join(resolve(options.resultsDir ?? RESULTS_ROOT), runId);
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts > 1) process.exit(EXIT_ABORTED);
    err(
      '\nSIGINT — stopping after the current spawn is killed; partial results will be written (Ctrl-C again to force quit)'
    );
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const loaders = new Map<string, ReturnType<typeof createFsTemplateLoader>>();
  let results: Awaited<ReturnType<typeof runEval>>;
  try {
    results = await runEval(
      {
        trial: {
          adapters: ADAPTERS,
          providerFor,
          dryRun: options.dryRun,
          toolbox: { git, shell },
          logger,
          correctiveRetries: settings.harness.correctiveRetries,
          keepWorkspaces: options.keepWorkspaces,
          runDir,
        },
        store: createResultsStore({ runDir, appendFile: createAppendFile(), writeFile: createAtomicWriteFile() }),
        loaderFor: (arm) => {
          const dir = arm.templatesDir ?? baselineTemplates;
          let loader = loaders.get(dir);
          if (loader === undefined) {
            loader = createFsTemplateLoader(abs(dir));
            loaders.set(dir, loader);
          }
          return loader;
        },
        preflight: (fixtures) => runCheck(fixtures, { git, shell }, controller.signal),
        signal: controller.signal,
      },
      {
        runId,
        fixtures: loaded.value.fixtures,
        fixtureSetHash: loaded.value.fixtureSetHash,
        arms,
        k: options.k,
        budget: {
          maxTokens: options.maxTokens,
          reserveTokens: options.reserveTokens,
          ...(options.maxWallMin !== undefined ? { maxWallMs: options.maxWallMin * 60_000 } : {}),
          allowUnmetered: options.allowUnmetered,
        },
        dryRun: options.dryRun,
        ...(await gitInfo(git)),
        maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
      }
    );
  } finally {
    process.off('SIGINT', onSigint);
  }

  if (!results.ok) {
    if (results.error instanceof AbortError) {
      err(`aborted — partial results in ${runDir}`);
      return EXIT_ABORTED;
    }
    err(results.error.message);
    return EXIT_FAILURE;
  }
  out(`results: ${runDir}/results.json\nsummary: ${runDir}/summary.md`);
  if (results.value.stoppedReason !== 'completed') {
    err(`stopped early (${results.value.stoppedReason}) — unfinished items are marked incomplete in the summary`);
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
};

/** Merge two single-arm results files into one paired comparison and print it. Offline, 0 tokens. */
const executeReport = async (baselinePath: string, candidatePath: string): Promise<number> => {
  const a = await readResults(resolve(baselinePath));
  const b = await readResults(resolve(candidatePath));
  if (!a.ok) {
    err(a.error.message);
    return EXIT_FAILURE;
  }
  if (!b.ok) {
    err(b.error.message);
    return EXIT_FAILURE;
  }
  // `relabel` below moves every trial onto one arm, so a multi-arm file (from `pnpm eval compare`)
  // would silently pool both of its arms into one. Only single-arm `run` outputs are reportable.
  for (const [path, file] of [
    [baselinePath, a.value],
    [candidatePath, b.value],
  ] as const) {
    if (file.arms.length !== 1) {
      err(
        `${path}: has ${String(file.arms.length)} arms (${file.arms.map((arm) => arm.name).join(', ')}) — report takes two single-arm \`run\` results; a \`compare\` results file already holds its comparison in summary.md`
      );
      return EXIT_FAILURE;
    }
  }
  if (a.value.k !== b.value.k) {
    err(`k differs (${String(a.value.k)} vs ${String(b.value.k)}) — the two runs are not comparable`);
    return EXIT_FAILURE;
  }
  // Both files are single-arm runs, so both name their arm 'baseline'. Relabel trials AND the
  // incomplete-item lines, then recompute metrics/usage from the relabelled trials — the stored maps
  // are keyed by the original name and would overwrite each other.
  const relabel = (r: ResultsFile, name: string): ResultsFile => {
    const original = r.arms[0]?.name ?? 'baseline';
    return {
      ...r,
      arms: r.arms.map((arm) => ({ ...arm, name })),
      trials: r.trials.map((t) => ({ ...t, arm: name })),
      incompleteItems: r.incompleteItems.map((line) =>
        line.startsWith(`${original}:`) ? `${name}:${line.slice(original.length + 1)}` : line
      ),
    };
  };
  const base = relabel(a.value, 'baseline');
  const cand = relabel(b.value, 'candidate');
  const trials = [...base.trials, ...cand.trials];
  const flows = [...new Set(trials.map((t) => t.flow))];
  const { metrics, usage } = summarizeArms(trials, ['baseline', 'candidate'], a.value.k, []);
  const merged: ResultsFile = {
    ...base,
    runId: `${a.value.runId} vs ${b.value.runId}`,
    arms: [...base.arms, ...cand.arms],
    trials,
    metrics,
    usage,
    incompleteItems: [...base.incompleteItems, ...cand.incompleteItems],
    comparison: compareArms(trials, 'baseline', 'candidate', a.value.k, flows),
    notes: [
      ...(a.value.fixtureSetHash === b.value.fixtureSetHash
        ? []
        : ['the two runs used DIFFERENT fixture sets — only items present in both are paired']),
      ...(a.value.dryRun || b.value.dryRun ? ['at least one input was a dry run'] : []),
    ],
  };
  out(renderSummary(merged));
  return EXIT_OK;
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const command = parseCommand(argv);
  if (!command.ok) {
    err(command.error.message === USAGE ? USAGE : `${command.error.message}\n\n${USAGE}`);
    return command.error.message === USAGE ? EXIT_OK : EXIT_FAILURE;
  }
  const cmd = command.value;
  switch (cmd.kind) {
    case 'check':
      return executeCheck(cmd.options);
    case 'run':
      return executeRun(cmd.options);
    case 'compare':
      return executeRun(cmd.options, cmd.candidate);
    case 'report':
      return executeReport(cmd.baselinePath, cmd.candidatePath);
  }
};

// ESM main-module guard (same idiom as scripts/sync-skills.ts): run only when invoked directly,
// never when a test imports this module.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  process.exitCode = await main(process.argv.slice(2));
}
