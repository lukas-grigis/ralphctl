import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { type Budget, type BudgetConfig, createBudget, type StopReason } from './budget.ts';
import type { EvalFlow } from './fixture-schema.ts';
import type { TrialPlan } from './flows/adapter.ts';
import { compareArms, itemKeyOf, summarizeArms } from './metrics.ts';
import type { CheckOutcome } from './oracle.ts';
import type { ResultsStore } from './results-store.ts';
import { runTrial, type TrialDeps } from './run-trial.ts';
import type { ArmConfig, Fixture, ResultsFile, TrialRecord } from './types.ts';

export interface RunConfig {
  readonly runId: string;
  readonly fixtures: readonly Fixture[];
  readonly fixtureSetHash: string;
  /** One arm (`run`) or two (`compare`; the first is A / baseline). */
  readonly arms: readonly ArmConfig[];
  readonly k: number;
  readonly budget: BudgetConfig;
  readonly dryRun: boolean;
  readonly gitSha: string | null;
  readonly gitDirty: boolean | null;
  /** Stop after this many infrastructure errors in a row — a misconfigured model must not burn the budget. */
  readonly maxConsecutiveErrors: number;
  readonly notes?: readonly string[];
}

export interface RunDeps {
  readonly trial: TrialDeps;
  readonly store: ResultsStore;
  /** Template loader for an arm — the checked-out prompts, or a `--candidate-templates` directory. */
  readonly loaderFor: (arm: ArmConfig) => TemplateLoader;
  /** Label proof for every fixture (`pnpm eval check`); a failing fixture aborts the run before any spend. */
  readonly preflight: (
    fixtures: readonly Fixture[]
  ) => Promise<Result<readonly CheckOutcome[], StorageError | AbortError>>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

type RunError = AbortError | ParseError | StorageError;

interface WorkItem {
  readonly fixture: Fixture;
  readonly planIndex: number;
  readonly trialIndex: number;
  readonly arm: ArmConfig;
}

/**
 * Expand fixtures × plans × k into the run order. Trials run serially. For a two-arm run the arms are
 * INTERLEAVED per trial and the arm that goes first alternates per item (engineering judgment), so
 * provider drift and ordering effects don't systematically favour one arm.
 */
export const planWork = (
  fixtures: readonly Fixture[],
  arms: readonly ArmConfig[],
  k: number,
  plansOf: (f: Fixture) => number
): readonly WorkItem[] => {
  const work: WorkItem[] = [];
  let itemIndex = 0;
  for (const fixture of fixtures) {
    for (let planIndex = 0; planIndex < plansOf(fixture); planIndex++) {
      const ordered = itemIndex % 2 === 0 ? arms : [...arms].reverse();
      for (let trialIndex = 1; trialIndex <= k; trialIndex++) {
        for (const arm of ordered) work.push({ fixture, planIndex, trialIndex, arm });
      }
      itemIndex++;
    }
  }
  return work;
};

const buildResults = (
  config: RunConfig,
  plannedKeys: readonly string[],
  trials: readonly TrialRecord[],
  budget: Budget,
  now: number,
  startedAt: string,
  stoppedReason: ResultsFile['stoppedReason']
): ResultsFile => {
  const flows = [...new Set(trials.map((t) => t.flow))] as EvalFlow[];
  const { metrics, usage, incomplete } = summarizeArms(
    trials,
    config.arms.map((a) => a.name),
    config.k,
    plannedKeys
  );
  const [armA, armB] = config.arms;
  const comparison =
    armA !== undefined && armB !== undefined ? compareArms(trials, armA.name, armB.name, config.k, flows) : undefined;
  return {
    schemaVersion: 1,
    runId: config.runId,
    startedAt,
    finishedAt: new Date(now).toISOString(),
    stoppedReason,
    gitSha: config.gitSha,
    gitDirty: config.gitDirty,
    k: config.k,
    fixtureSetHash: config.fixtureSetHash,
    dryRun: config.dryRun,
    arms: config.arms,
    budget: budget.snapshot(now),
    trials,
    metrics,
    usage,
    incompleteItems: incomplete,
    ...(comparison !== undefined ? { comparison } : {}),
    notes: config.notes ?? [],
  };
};

/**
 * Run the eval: preflight the fixture labels, then execute trials serially under the admission-based
 * budget, appending each finished trial to `trials.ndjson`, and finish with `results.json` +
 * `summary.md`. A budget / wall / unmetered / error stop is NOT a failure — the partial results are
 * written with the matching `stoppedReason` and unfinished items marked incomplete. `AbortError` is
 * never swallowed: partial results are flushed first (this function owns that state), then the
 * error is returned so `main` can exit 130.
 */
export const runEval = async (deps: RunDeps, config: RunConfig): Promise<Result<ResultsFile, RunError>> => {
  const plansOf = (f: Fixture): number => deps.trial.adapters[f.flow].plans(f).length;
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();

  const preflight = await deps.preflight(config.fixtures);
  if (!preflight.ok) return Result.error(preflight.error);
  const unproven = preflight.value.filter((o) => !o.ok);
  if (unproven.length > 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `fixture labels not proven by their oracle — fix or remove before spending tokens:\n${unproven.map((o) => `  ${o.fixtureId}: ${o.lines.join(' | ')}`).join('\n')}`,
      })
    );
  }

  const plannedKeys = config.fixtures.flatMap((f) =>
    deps.trial.adapters[f.flow].plans(f).map((p) => itemKeyOf({ flow: f.flow, fixtureId: f.id, variant: p.variant }))
  );
  const budget = createBudget(config.budget, startedMs);
  const trials: TrialRecord[] = [];
  const planCache = new Map<string, readonly TrialPlan[]>();
  let stopped: StopReason | 'aborted' | 'errors' | undefined;
  let abortError: AbortError | undefined;
  let consecutiveErrors = 0;

  for (const item of planWork(config.fixtures, config.arms, config.k, plansOf)) {
    if (deps.signal?.aborted === true) {
      abortError = new AbortError({ elementName: 'eval-run', reason: 'eval run aborted' });
      stopped = 'aborted';
      break;
    }
    const admission = budget.admit(item.fixture.flow, now());
    if (!admission.admitted) {
      stopped = admission.reason;
      break;
    }
    const plans = planCache.get(item.fixture.id) ?? deps.trial.adapters[item.fixture.flow].plans(item.fixture);
    planCache.set(item.fixture.id, plans);
    const plan = plans[item.planIndex];
    if (plan === undefined) continue;

    const ran = await runTrial(deps.trial, {
      fixture: item.fixture,
      plan,
      arm: item.arm,
      trialIndex: item.trialIndex,
      loader: deps.loaderFor(item.arm),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    if (!ran.ok) {
      abortError = ran.error;
      stopped = 'aborted';
      break;
    }
    const record = ran.value;
    trials.push(record);
    const appended = await deps.store.appendTrial(record);
    if (!appended.ok) return Result.error(appended.error);

    const spentSomething =
      record.usage.inputTokens !== null ||
      record.usage.outputTokens !== null ||
      (record.usage.cacheReadTokens ?? null) !== null ||
      (record.usage.cacheCreationTokens ?? null) !== null;
    if (record.graded || spentSomething) {
      budget.record(item.fixture.flow, {
        ...(record.usage.inputTokens !== null ? { inputTokens: record.usage.inputTokens } : {}),
        ...(record.usage.outputTokens !== null ? { outputTokens: record.usage.outputTokens } : {}),
        ...(record.usage.cacheReadTokens != null ? { cacheReadTokens: record.usage.cacheReadTokens } : {}),
        ...(record.usage.cacheCreationTokens != null ? { cacheCreationTokens: record.usage.cacheCreationTokens } : {}),
        metered: record.usage.metered,
      });
    }
    consecutiveErrors = record.graded ? 0 : consecutiveErrors + 1;
    if (consecutiveErrors >= config.maxConsecutiveErrors) {
      stopped = 'errors';
      break;
    }
  }

  const results = buildResults(config, plannedKeys, trials, budget, now(), startedAt, stopped ?? 'completed');
  const finalized = await deps.store.finalize(results);
  if (!finalized.ok) return Result.error(finalized.error);
  return abortError !== undefined ? Result.error(abortError) : Result.ok(results);
};
