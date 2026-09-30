import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { createShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import { ADAPTERS } from '../../scripts/eval/adapters.ts';
import { buildArm } from '../../scripts/eval/arms.ts';
import { loadFixtures } from '../../scripts/eval/load-fixtures.ts';
import { createResultsStore } from '../../scripts/eval/results-store.ts';
import type { RunConfig, RunDeps } from '../../scripts/eval/run.ts';
import type { ArmConfig, Fixture } from '../../scripts/eval/types.ts';
import type { ScriptedSignal } from '../../scripts/eval/fake-provider.ts';
import { noopLogger } from './noop-logger.ts';

/** Signals for a well-formed evaluator verdict: `failing` dimensions fail, everything else passes. */
export const evaluationSignals = (status: 'passed' | 'failed', failing: readonly string[] = []): ScriptedSignal[] => [
  {
    type: 'evaluation',
    status,
    dimensions: ['correctness', 'completeness', 'safety', 'consistency', 'robustness'].map((dimension) => ({
      dimension,
      passed: !failing.includes(dimension),
      finding: failing.includes(dimension) ? 'defect found' : 'no issue',
    })),
    criteria: [{ id: 'C1', passed: status === 'passed', evidence: 'ran the command' }],
  },
];

export interface EvalRunHarness {
  readonly deps: RunDeps;
  readonly config: RunConfig;
  readonly runDir: string;
  /** Parent directory of every per-trial workspace — empty after a clean run. */
  readonly workspaceRoot: string;
  readonly fixtures: readonly Fixture[];
}

export interface HarnessOptions {
  /** Directory the fixtures were written to (see `writeMiniFixtures`). */
  readonly fixturesRoot: string;
  /** Scratch directory for run output + workspaces. */
  readonly scratch: string;
  readonly provider: HeadlessAiProvider;
  readonly k?: number;
  readonly maxTokens?: number;
  readonly allowUnmetered?: boolean;
  readonly arms?: readonly ArmConfig[];
  readonly idGlob?: string;
  readonly signal?: AbortSignal;
  readonly preflight?: RunDeps['preflight'];
  readonly maxConsecutiveErrors?: number;
}

/**
 * Wire `runEval` exactly as `main.ts` does — real adapters, real template loader, real git / shell
 * runners, real results store — but with an injected provider and no label preflight by default.
 */
export const makeEvalRunHarness = async (opts: HarnessOptions): Promise<EvalRunHarness> => {
  const loaded = await loadFixtures(opts.fixturesRoot, opts.idGlob !== undefined ? { idGlob: opts.idGlob } : {});
  if (!loaded.ok) throw new Error(loaded.error.message);
  const runDir = join(opts.scratch, 'run');
  const workspaceRoot = join(opts.scratch, 'workspaces');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const baseline = buildArm({ name: 'baseline' });
  if (!baseline.ok) throw new Error(baseline.error.message);
  const loader = createFsTemplateLoader(defaultTemplatesDir());
  const deps: RunDeps = {
    trial: {
      adapters: ADAPTERS,
      providerFor: () => opts.provider,
      dryRun: false,
      toolbox: { git: createGitRunner(), shell: createShellScriptRunner(), tmpRoot: workspaceRoot },
      logger: noopLogger,
      correctiveRetries: 2,
      keepWorkspaces: false,
      runDir,
    },
    store: createResultsStore({ runDir, appendFile: createAppendFile(), writeFile: createAtomicWriteFile() }),
    loaderFor: () => loader,
    preflight: opts.preflight ?? (async () => Result.ok([])),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const config: RunConfig = {
    runId: 'test-run',
    fixtures: loaded.value.fixtures,
    fixtureSetHash: loaded.value.fixtureSetHash,
    arms: opts.arms ?? [baseline.value],
    k: opts.k ?? 1,
    budget: { maxTokens: opts.maxTokens ?? 1_000_000, reserveTokens: 0, allowUnmetered: opts.allowUnmetered ?? false },
    dryRun: false,
    gitSha: null,
    gitDirty: null,
    maxConsecutiveErrors: opts.maxConsecutiveErrors ?? 3,
  };
  return { deps, config, runDir, workspaceRoot, fixtures: loaded.value.fixtures };
};
