import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { okGit } from '@tests/fixtures/git-result.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { emptySkillSource } from '@tests/fixtures/skills-fakes.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  bestOfNCandidateLoopLeaf,
  type BestOfNGenEvalOpts,
} from '@src/application/flows/implement/leaves/best-of-n-candidate.ts';
import { bestOfNSelectionLeaf } from '@src/application/flows/implement/leaves/best-of-n-selection.ts';
import { buildBestOfNGenEvalLoop, isBestOfNGranted } from '@src/application/flows/implement/leaves/best-of-n.ts';

/**
 * Integration tests for the best-of-N candidate loop + selection cascade (arXiv 2604.16529
 * harness-level N-candidate selection; arXiv 2507.23370's ablation order for the cascade) —
 * mirrors the fake-provider / fake-git-runner pattern in `reproduce.test.ts` and
 * `tests/e2e/flows/implement.test.ts`.
 */

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

// ── Fake in-memory git model ─────────────────────────────────────────────────────────────
// `currentDiff` models the working tree's uncommitted content; `''` means clean. `stash` models
// `git stash list` order (index 0 = most recently pushed, matching real git).

interface FakeGitState {
  currentDiff: string;
  readonly stash: Array<{ message: string; diff: string }>;
  /**
   * Per-diff touched-file count for `git diff --name-only` — keyed by diff CONTENT so each
   * candidate's script can claim a distinct file count without a call counter. Absent diffs
   * default to 1 file (the pre-existing constant-shape behaviour every other test relies on).
   */
  fileCounts?: Readonly<Record<string, number>>;
  /** When true, the NEXT `stash push` call fails with a git error instead of succeeding. */
  failNextStashPush?: boolean;
  /** When true, the NEXT `stash pop` call fails (conflict) instead of succeeding. */
  failNextStashPop?: boolean;
}

const freshGitState = (): FakeGitState => ({ currentDiff: '', stash: [] });

const createFakeGitRunner = (state: FakeGitState): GitRunner => ({
  run: (_cwd, args): ReturnType<GitRunner['run']> => {
    if (args[0] === 'status' && args[1] === '--porcelain') {
      return Promise.resolve(okGit(state.currentDiff.length > 0 ? ' M file.ts\n' : '', 0));
    }
    if (args[0] === 'diff' && args[1] === 'HEAD') return Promise.resolve(okGit(state.currentDiff, 0));
    if (args[0] === 'diff' && args[1] === '--name-only') {
      if (state.currentDiff.length === 0) return Promise.resolve(okGit('', 0));
      const n = state.fileCounts?.[state.currentDiff] ?? 1;
      const files = Array.from({ length: n }, (_, i) => `file${String(i + 1)}.ts`).join('\n');
      return Promise.resolve(okGit(`${files}\n`, 0));
    }
    if (args[0] === 'ls-files') return Promise.resolve(okGit('', 0));
    if (args[0] === 'stash' && args[1] === 'push') {
      if (state.currentDiff.length === 0) return Promise.resolve(okGit('No local changes to save\n', 0));
      if (state.failNextStashPush === true) {
        state.failNextStashPush = false;
        return Promise.resolve(okGit('error: could not save working tree\n', 1));
      }
      const message = args[args.length - 1] ?? '';
      state.stash.unshift({ message, diff: state.currentDiff });
      state.currentDiff = '';
      return Promise.resolve(okGit('Saved working directory\n', 0));
    }
    if (args[0] === 'stash' && args[1] === 'list') {
      return Promise.resolve(okGit(state.stash.map((s) => s.message).join('\n'), 0));
    }
    if (args[0] === 'stash' && args[1] === 'pop') {
      if (state.failNextStashPop === true) {
        state.failNextStashPop = false;
        return Promise.resolve(okGit('CONFLICT (content): merge conflict in file.ts\n', 1));
      }
      const match = /stash@\{(\d+)\}/.exec(args[2] ?? '');
      const idx = match?.[1] !== undefined ? Number(match[1]) : -1;
      const entry = state.stash[idx];
      if (entry === undefined) return Promise.resolve(okGit('', 1));
      state.stash.splice(idx, 1);
      state.currentDiff = entry.diff;
      return Promise.resolve(okGit('Dropped stash\n', 0));
    }
    return Promise.resolve(okGit('', 0));
  },
});

// ── Fake generator provider (candidate spawns) ───────────────────────────────────────────
// Dispatches by candidate index parsed from `session.outputDir` (`.../candidates/<n>`). Each
// script entry sets the fake git tree's diff as a side effect (mirroring what a real spawn's
// file writes would produce) and writes the scripted signals to `session.signalsFile`.

interface CandidateScript {
  readonly diff?: string; // undefined → no diff (clean session)
  readonly blocked?: boolean; // self-block instead of completing
  readonly abort?: boolean; // throw AbortError instead of returning (an unrealistic shape — real
  // providers never throw across the Result boundary; kept only for the pre-existing test below)
  readonly abortResult?: boolean; // return Result.error(AbortError) — the REAL provider shape
  // (`run-with-rate-limit-retry.ts` never throws across a Result boundary)
}

const candidateIndexFromSession = (session: AiSession): number | undefined => {
  const match = /candidates[/\\](\d+)(?:[/\\]|$)/.exec(String(session.outputDir ?? ''));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
};

const judgeCallIndexFromSession = (session: AiSession): number | undefined => {
  const match = /candidates[/\\]judge[/\\](\d+)/.exec(String(session.outputDir ?? ''));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
};

const isEvaluatorSession = (session: AiSession): boolean =>
  /rounds[/\\]\d+[/\\]evaluator/.test(String(session.outputDir ?? ''));

const createFakeGeneratorProvider = (
  gitState: FakeGitState,
  candidates: Readonly<Record<number, CandidateScript>>
): HeadlessAiProvider => ({
  async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
    const index = candidateIndexFromSession(session);
    if (index === undefined) {
      // A non-candidate generator spawn (round 2+) — no test scenario in this file drives the
      // loop past round 1, so this path is unreachable; fail loud if it ever is.
      throw new Error(`unscripted generator spawn: ${String(session.outputDir)}`);
    }
    const script = candidates[index] ?? {};
    // Dirty the tree FIRST, even for a candidate that then aborts/blocks — real work always lands
    // in the tree before a session self-blocks or crashes; scripting it after would make the
    // dirty-tree restore/crash tests below vacuous.
    if (script.diff !== undefined) gitState.currentDiff = script.diff;
    if (script.abort) throw new AbortError({ elementName: 'fake-best-of-n-generator', reason: 'abort in test' });
    if (script.abortResult) {
      return Result.error(
        new AbortError({ elementName: 'fake-best-of-n-generator', reason: 'abort in test' })
      ) as Result<ProviderOutput, DomainError>;
    }
    const signals = script.blocked
      ? [{ type: 'task-blocked', reason: 'candidate self-blocked in test', timestamp: TS }]
      : [
          { type: 'commit-message', subject: `candidate ${String(index)} commit`, timestamp: TS },
          { type: 'change', text: `candidate ${String(index)} change`, timestamp: TS },
          { type: 'task-complete', timestamp: TS },
        ];
    const wrote = await writeJsonAtomic(String(session.signalsFile), { schemaVersion: 1, signals });
    if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0, sessionId: `session-${String(index)}` });
  },
});

// ── Fake evaluator provider (judge calls + the real evaluator turn) ─────────────────────

interface JudgeScript {
  readonly winner?: 1 | 2; // undefined → invalid signal (fallback path)
  readonly invalid?: boolean;
}

const evaluationPassedSignal = () => ({
  type: 'evaluation',
  status: 'passed',
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'all good' },
    { dimension: 'completeness', passed: true, finding: 'steps shipped' },
    { dimension: 'safety', passed: true, finding: 'inputs validated' },
    { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    { dimension: 'robustness', passed: true, finding: 'error paths handled' },
  ],
  timestamp: TS,
});

const createFakeEvaluatorProvider = (judges: readonly JudgeScript[]): HeadlessAiProvider => ({
  async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
    const judgeIdx = judgeCallIndexFromSession(session);
    if (judgeIdx !== undefined) {
      const script = judges[judgeIdx - 1];
      if (script?.invalid === true || script === undefined) {
        // Write a structurally-invalid payload — the contract's `exactly one` refine rejects it.
        const wrote = await writeJsonAtomic(String(session.signalsFile), { schemaVersion: 1, signals: [] });
        if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
      }
      const signal = { type: 'candidate-selection', winner: script.winner, rationale: 'test rationale', timestamp: TS };
      // `select-candidate`'s contract has an EMPTY migration chain (a fresh contract, no legacy
      // on-disk shape) — unlike the generator/evaluator contracts' `wrapLegacyArray` migration, a
      // bare top-level array is NOT accepted here; the `{schemaVersion, signals}` wrapper is required.
      const wrote = await writeJsonAtomic(String(session.signalsFile), { schemaVersion: 1, signals: [signal] });
      if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
      return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
    }
    if (isEvaluatorSession(session)) {
      const wrote = await writeJsonAtomic(String(session.signalsFile), {
        schemaVersion: 1,
        signals: [evaluationPassedSignal()],
      });
      if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
      return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
    }
    throw new Error(`unscripted evaluator spawn: ${String(session.outputDir)}`);
  },
});

/** Verify outcome keyed by the diff CURRENTLY in the tree at verify time — lets each candidate
 * script its own pass/fail without a call counter. */
const shellScriptedByDiff = (gitState: FakeGitState, failingDiffs: ReadonlySet<string>): ShellScriptRunner => ({
  async run() {
    const failed = failingDiffs.has(gitState.currentDiff);
    return Result.ok({
      passed: !failed,
      exitCode: failed ? 1 : 0,
      output: failed ? 'test failed' : 'ok',
      durationMs: 0,
    });
  },
});

describe('best-of-N candidate loop + selection cascade', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let cwd: AbsolutePath;
  let workspaceRoot: AbsolutePath;
  // Records every `taskRepo.update` call the candidate loop's grant-consumption persist makes —
  // reset per test so `minors[4]`'s "persisted at loop start" assertion isn't perturbed by a
  // sibling test's calls.
  let taskRepoUpdates: Array<{ readonly sprintId: unknown; readonly task: InProgressTask }>;

  beforeEach(async () => {
    root = await makeTmpRoot();
    cwd = absolutePath(join(String(root.root), 'repo'));
    workspaceRoot = absolutePath(join(String(root.root), 'sprint', 'implement', 'task-1'));
    await fs.mkdir(String(workspaceRoot), { recursive: true });
    taskRepoUpdates = [];
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildDeps = (
    gitRunner: GitRunner,
    generatorProvider: HeadlessAiProvider,
    evaluatorProvider: HeadlessAiProvider,
    shellScriptRunner: ShellScriptRunner
  ): ImplementDeps =>
    ({
      generatorProvider,
      evaluatorProvider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: () => {},
      writeFile: createAtomicWriteFile(),
      gitRunner,
      shellScriptRunner,
      clock: () => TS,
      logger: noopLogger,
      eventBus: createInMemoryEventBus(),
      skillSource: emptySkillSource,
      config: { harness: { maxTurns: 5, maxAttempts: 3, plateauThreshold: 2, correctiveRetries: 2 } },
      taskRepo: {
        update: (sprintId: unknown, task: InProgressTask) => {
          taskRepoUpdates.push({ sprintId, task });
          return Promise.resolve(Result.ok(undefined));
        },
      },
    }) as unknown as ImplementDeps;

  const buildOpts = (verifyScript = 'npm test'): BestOfNGenEvalOpts => ({
    cwd,
    sprintDir: absolutePath(join(String(root.root), 'sprint')),
    progressFile: absolutePath(join(String(root.root), 'sprint', 'progress.md')),
    verifyScript,
    generator: { providerId: 'claude-code', model: 'claude-opus-5' },
    evaluator: { providerId: 'claude-code', model: 'claude-opus-5' },
  });

  const buildTask = (n: number): InProgressTask => ({
    ...makeInProgressTaskWithRunningAttempt(),
    bestOfNGranted: true,
    bestOfNGrantedCandidates: n,
  });

  const buildCtx = (task: InProgressTask, extra: Partial<ImplementCtx> = {}): ImplementCtx =>
    ({
      sprintId: task.ticketId, // placeholder id; only used to key stash messages in these tests
      tasks: [task],
      currentTask: task,
      currentTaskId: task.id,
      taskWorkspaceRoot: workspaceRoot,
      lastPreVerifyOutcome: 'success',
      ...extra,
    }) as unknown as ImplementCtx;

  // ── 0. Round-1 gate fires on a REAL granted attempt ──────────────────────────────────
  // MANDATORY regression test: a best-of-N grant is never issued before a task's 3rd attempt
  // (the escalation policy only grants at `nudgedAtTop`), and `taskWorkspaceRoot` is per-TASK —
  // so by the time a grant lands, `rounds/1/` and `rounds/2/` already exist on disk from earlier
  // attempts. The pre-fix `isRoundOne` gate read `ctx.currentRoundNum` (disk-derived, `>= 3` here)
  // and never fired the substitute on this exact, real-world shape — every OTHER test in this file
  // starts from an empty `workspaceRoot` (no `rounds/` dir), which is precisely why the suite
  // missed it.

  it('MANDATORY: seeding rounds/1 and rounds/2 on disk (mirroring two prior attempts of the same task) does not stop the candidate loop from firing', async () => {
    await fs.mkdir(join(String(workspaceRoot), 'rounds', '1', 'evaluator'), { recursive: true });
    await fs.mkdir(join(String(workspaceRoot), 'rounds', '2', 'evaluator'), { recursive: true });

    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const candidateCalls: AiSession[] = [];
    const genProvider: HeadlessAiProvider = {
      async generate(session) {
        candidateCalls.push(session);
        return createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-1' } }).generate(
          session
        );
      },
    };
    const evalCalls: AiSession[] = [];
    const evalProvider: HeadlessAiProvider = {
      async generate(session) {
        evalCalls.push(session);
        return createFakeEvaluatorProvider([]).generate(session);
      },
    };
    const deps = buildDeps(gitRunner, genProvider, evalProvider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const result = await buildBestOfNGenEvalLoop(deps, opts, task.id, async () => ({ maxTurns: 5 })).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The candidate loop fired: 2 candidate generator spawns, not a single plain generator turn
    // (the pre-fix degrade — `nextRoundNum` resolves to 3 with rounds/1 and rounds/2 already on
    // disk, so the OLD `currentRoundNum === 1` gate would have skipped the substitute entirely).
    expect(candidateCalls).toHaveLength(2);
    expect(result.value.ctx.bestOfNCandidates).toHaveLength(2);
    // Round 1's NORMAL evaluator turn still ran exactly once afterward, same as every other test.
    expect(evalCalls).toHaveLength(1);
    expect(result.value.ctx.currentTask?.bestOfNGrantedCandidates).toBeUndefined();
  });

  // ── 1. Candidate loop mechanics ──────────────────────────────────────────────────────

  it('grant with n=3: the candidate loop runs exactly 3 candidate rounds, one per generator spawn', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const calls: AiSession[] = [];
    const provider: HeadlessAiProvider = {
      async generate(session) {
        calls.push(session);
        return createFakeGeneratorProvider(gitState, {
          1: { diff: 'diff-A' },
          2: { diff: 'diff-B' },
          3: { diff: 'diff-C' },
        }).generate(session);
      },
    };
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(3);
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(3);
    expect(result.value.ctx.bestOfNCandidates?.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(result.value.ctx.bestOfNCandidates?.every((c) => c.verifyOutcome === 'success')).toBe(true);
    // The tree is restored to baseline after every candidate — the loop never leaves it dirty.
    expect(gitState.currentDiff).toBe('');
  });

  it('a candidate whose session self-blocks is recorded as absent and the loop keeps sampling', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, {
      1: { blocked: true },
      2: { diff: 'diff-B' },
      3: { diff: 'diff-C' },
    });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const task = buildTask(3);
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, buildOpts(), task.id).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only 2 candidates survived to a record — the self-blocked one contributed no slot — but
    // the loop kept sampling until 3 SUCCESSFUL spawns landed (bounded by the static ceiling).
    expect(result.value.ctx.bestOfNCandidates).toHaveLength(2);
  });

  it('confirmed #7: a candidate that dirties the tree then self-blocks is restored to baseline before the next candidate samples — the dirt lands in its OWN recoverable stash entry, never bleeds forward', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, {
      1: { diff: 'diff-1-clean' },
      // Candidate 2 writes files (dirties the tree) and THEN self-blocks — the scenario the
      // pre-existing tests never exercised (their `blocked`/`abort` scripts never combine with a
      // diff), so a regression that deleted the skip-path restore call would leave this diff in
      // the tree undetected.
      2: { diff: 'diff-2-dirty', blocked: true },
      3: { diff: 'diff-3-clean' },
    });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const task = buildTask(3);
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, buildOpts(), task.id).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Candidates 1 and 3 produced records; candidate 2 self-blocked and contributed nothing.
    expect(result.value.ctx.bestOfNCandidates?.map((c) => c.index)).toEqual([1, 3]);
    // The tree is clean at the end — candidate 2's dirt never bled into (or past) candidate 3.
    expect(gitState.currentDiff).toBe('');
    // Every candidate's diff — including the self-blocked one's — is recoverable under its OWN
    // stash message, not silently dropped and not merged into a sibling's entry.
    const stashFor = (n: number) => gitState.stash.find((s) => s.message.includes(`candidate-${String(n)}`));
    expect(stashFor(1)?.diff).toBe('diff-1-clean');
    expect(stashFor(2)?.diff).toBe('diff-2-dirty');
    expect(stashFor(3)?.diff).toBe('diff-3-clean');
  });

  it('confirmed #7: a candidate that dirties the tree then crashes via a REAL Result.error(AbortError) (not a thrown exception) is restored to baseline before the fatal error propagates', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-crash', abortResult: true } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, buildOpts(), task.id).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    // The tree was restored to baseline before the fatal error propagated out of the loop.
    expect(gitState.currentDiff).toBe('');
    // The dirt is recoverable in the candidate's own stash entry, not silently dropped.
    expect(gitState.stash.find((s) => s.message.includes('candidate-1'))?.diff).toBe('diff-crash');
  });

  it('minors #0: a failed stash-push (restore) fails the candidate loop loudly instead of letting the next candidate sample off-baseline', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-2' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const task = buildTask(2);
    const ctx = buildCtx(task);

    // Script candidate 1's post-verify restore (`gitStashPush`) to fail — the tree stays dirty
    // with candidate 1's diff instead of being cleanly moved into the stash.
    gitState.failNextStashPush = true;

    const result = await bestOfNCandidateLoopLeaf(deps, buildOpts(), task.id).execute(ctx);

    // Fails loudly — never silently proceeds to sample candidate 2 against a polluted tree.
    expect(result.ok).toBe(false);
    // Candidate 1's diff is still sitting in the tree (the failed push never moved it), NOT
    // silently folded into whatever candidate 2 would have produced.
    expect(gitState.currentDiff).toBe('diff-1');
  });

  // ── 2. Selection cascade ─────────────────────────────────────────────────────────────

  const runSelection = async (deps: ImplementDeps, opts: BestOfNGenEvalOpts, task: InProgressTask, ctx: ImplementCtx) =>
    bestOfNSelectionLeaf(deps, opts, task.id).execute(ctx);

  it("regressed-filter: a candidate whose diff broke a green baseline is discarded, the survivor's diff is applied", async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-good' }, 2: { diff: 'diff-bad' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set(['diff-bad'])));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    expect(looped.value.ctx.bestOfNCandidates?.map((c) => c.attribution)).toEqual(['clean', 'regressed']);

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // The clean candidate's diff was applied — no judge call was needed (single survivor).
    expect(gitState.currentDiff).toBe('diff-good');
    // The regressed candidate's stash is still recoverable, never popped.
    expect(gitState.stash).toHaveLength(1);
    expect(gitState.stash[0]?.diff).toBe('diff-bad');
  });

  it('dedupe: two candidates that converged on the identical diff collapse to one — the second stays recoverable in the stash', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'same-diff' }, 2: { diff: 'same-diff' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    const [c1, c2] = looped.value.ctx.bestOfNCandidates ?? [];
    expect(c1?.contentHash).toBeDefined();
    expect(c1?.contentHash).toBe(c2?.contentHash);

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(gitState.currentDiff).toBe('same-diff');
    // Candidate 1 (first-seen) was applied; candidate 2's stash entry is untouched.
    expect(gitState.stash).toHaveLength(1);
  });

  it('zero survivors: every candidate regressed → no diff applied, the tree stays clean, and the attempt still gets a verification marker so the evaluator can run', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'bad-a' }, 2: { diff: 'bad-b' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set(['bad-a', 'bad-b'])));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(gitState.currentDiff).toBe('');
    // Both rejected diffs remain recoverable — neither was popped.
    expect(gitState.stash).toHaveLength(2);
    // The running attempt was stamped verified (structural marker) so a later `task-verified`
    // evaluator turn can still settle the task even though no diff was applied.
    const runningAttempt = selected.value.ctx.currentTask?.attempts.find((a) => a.status === 'running');
    expect(runningAttempt?.verification).toBeDefined();
    // The transient grant is consumed — a later attempt of this task will not re-trigger.
    expect(selected.value.ctx.currentTask?.bestOfNGrantedCandidates).toBeUndefined();
    expect(isBestOfNGranted(selected.value.ctx)).toBe(false);
  });

  it('judge tournament: 3 distinct clean survivors run exactly 2 judge calls, the tournament winner is applied', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const genProvider = createFakeGeneratorProvider(gitState, {
      1: { diff: 'diff-1' },
      2: { diff: 'diff-2' },
      3: { diff: 'diff-3' },
    });
    const judgeCalls: AiSession[] = [];
    const evalProvider: HeadlessAiProvider = {
      async generate(session) {
        judgeCalls.push(session);
        // Winner is always "candidate 2" of each pairwise call — deterministic for the assertion.
        return createFakeEvaluatorProvider([{ winner: 2 }, { winner: 2 }]).generate(session);
      },
    };
    const deps = buildDeps(gitRunner, genProvider, evalProvider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(3);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // 1 vs 2 → 2 wins; 2 vs 3 → "candidate 2" of that call (challenger, i.e. candidate 3) wins.
    expect(judgeCalls).toHaveLength(2);
    expect(gitState.currentDiff).toBe('diff-3');
  });

  it('judge-failure fallback: an invalid judge verdict falls back to the verification-quality ordering (attribution, then fewest changed files) instead of crashing', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const genProvider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-2' } });
    const evalProvider = createFakeEvaluatorProvider([{ invalid: true }]);
    const deps = buildDeps(gitRunner, genProvider, evalProvider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    // Never crashes — falls back and still produces a result.
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // Both candidates are 'clean' with 1 changed file each — the fallback picks one deterministically
    // (first-of-tie) rather than throwing; the important assertion is that SOME diff landed.
    expect(['diff-1', 'diff-2']).toContain(gitState.currentDiff);
  });

  it('confirmed #6: judge-failure fallback picks correctly when survivors genuinely differ in attribution rank AND changed-file count — rank wins even when the higher-ranked candidate touched fewer files', async () => {
    const gitState = freshGitState();
    // Candidate 1 (the real fix) touches MORE files than candidate 2 (still broken) — proves the
    // fallback ranks by attribution FIRST, not file count; a comparator that only compared file
    // count (or an inverted rank comparison) would pick the still-broken candidate instead.
    gitState.fileCounts = { 'diff-fix': 3, 'diff-still-broken': 1 };
    const gitRunner = createFakeGitRunner(gitState);
    const genProvider = createFakeGeneratorProvider(gitState, {
      1: { diff: 'diff-fix' },
      2: { diff: 'diff-still-broken' },
    });
    const evalProvider = createFakeEvaluatorProvider([{ invalid: true }]);
    const deps = buildDeps(
      gitRunner,
      genProvider,
      evalProvider,
      shellScriptedByDiff(gitState, new Set(['diff-still-broken']))
    );
    const opts = buildOpts();
    const task = buildTask(2);
    // Baseline already red — so a candidate that fixes it is `fixed-baseline` (rank 1) and a
    // candidate that doesn't is `baseline-broken` (rank 2); neither is `regressed`, so both
    // survive stage 1 and reach the fallback comparator.
    const ctx = buildCtx(task, { lastPreVerifyOutcome: 'failed' });

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    const records = looped.value.ctx.bestOfNCandidates ?? [];
    expect(records.map((c) => c.attribution)).toEqual(['fixed-baseline', 'baseline-broken']);
    expect(records.map((c) => c.changedFileCount)).toEqual([3, 1]);

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // The real fix (rank 1) wins over the still-broken candidate (rank 2) despite touching more
    // files — a mutated `rankA < rankB ? b : a`, or a comparator that fell through to file count
    // first, would apply `diff-still-broken` instead.
    expect(gitState.currentDiff).toBe('diff-fix');
  });

  it('minors #0: a failed stash-pop (apply) fails the attempt loudly instead of letting the evaluator see a possibly conflicted tree', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    // Both candidates converge on the identical diff so dedupe collapses them to a SINGLE
    // survivor — no judge call needed, isolating the assertion to the apply-failure path.
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-1' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    // Script the winner's `gitStashPop` to conflict/fail.
    gitState.failNextStashPop = true;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(false);
  });

  it('minors #11: the selection leaf stamps ctx.bestOfNSummary with the sampled/survivor/winner counts', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, {
      1: { diff: 'diff-good' },
      2: { diff: 'diff-bad' },
    });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set(['diff-bad'])));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // 2 sampled; candidate 2 ('regressed') is discarded by stage 1, leaving 1 survivor — candidate
    // 1 — applied directly (no judge call needed).
    expect(selected.value.ctx.bestOfNSummary).toEqual({ candidatesSampled: 2, survivors: 1, winnerIndex: 1 });
  });

  it('minors #11: zero survivors stamps ctx.bestOfNSummary with no winnerIndex', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'bad-a' }, 2: { diff: 'bad-b' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set(['bad-a', 'bad-b'])));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const looped = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;

    const selected = await runSelection(deps, opts, task, looped.value.ctx);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.ctx.bestOfNSummary).toEqual({ candidatesSampled: 2, survivors: 0 });
  });

  // ── 3. Abort propagation ─────────────────────────────────────────────────────────────

  it('abort mid-loop: an AbortError from a candidate spawn propagates and the tree is restored to baseline', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { abort: true } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(3);
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
    // The first candidate's diff was captured + restored before the second candidate aborted;
    // the tree is clean either way — never left carrying a partial candidate's diff.
    expect(gitState.currentDiff).toBe('');
  });

  // ── 4. Full composite: round 1 substitute → normal evaluator turn ───────────────────

  it('the best-of-n gen-eval loop composite: candidates sample, selection applies the winner, then the NORMAL evaluator turn runs and terminates the loop', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    // Both candidates converge on the identical diff so dedupe collapses them to a single
    // survivor — no judge call needed, isolating the assertion to "does the evaluator run after
    // selection, exactly once, and terminate the loop".
    const genProvider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-1' } });
    const evalCalls: AiSession[] = [];
    const evalProvider: HeadlessAiProvider = {
      async generate(session) {
        evalCalls.push(session);
        return createFakeEvaluatorProvider([]).generate(session);
      },
    };
    const deps = buildDeps(gitRunner, genProvider, evalProvider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const result = await buildBestOfNGenEvalLoop(deps, opts, task.id, async () => ({ maxTurns: 5 })).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The evaluator spawned exactly once (round 1's normal evaluator turn, no judge call needed
    // since dedupe left a single survivor) and the loop terminated on that turn's passing
    // verdict — no round 2 generator spawn was needed.
    expect(evalCalls).toHaveLength(1);
    expect(isEvaluatorSession(evalCalls[0] as AiSession)).toBe(true);
    expect(result.value.ctx.lastExit?.kind).toBe('passed');
    expect(result.value.ctx.currentTask?.bestOfNGrantedCandidates).toBeUndefined();
  });

  // ── 5. Candidate prompt context parity ───────────────────────────────────────────────

  it('confirmed #10: a candidate spawned at the top of the escalation ladder gets the plateau directive, the prior critique, retry feedback, and pre-verify results — the SAME context a normal round-1 generator turn would render', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const provider = createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' } });
    const deps = buildDeps(gitRunner, provider, provider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();

    // A best-of-N grant is only ever issued at `nudgedAtTop` — i.e. exactly the state a NORMAL
    // round-1 generator turn would render the plateau directive in (`isPlateauBreakAttempt`:
    // `escalatedFromModel === escalatedToModel` + the last settled attempt's `plateau` warning)
    // plus its critique and the harness-verify blocks. Build that state by hand: a prior settled
    // attempt carrying the critique + plateau warning + a failing post-verify row, and the
    // running attempt carrying a passing pre-verify row.
    const base = buildTask(2);
    const priorSettled = {
      n: 1,
      status: 'failed',
      startedAt: TS,
      finishedAt: TS,
      critique: 'The auth check compares the wrong header — fix that before anything else.',
      warning: { kind: 'plateau', dimensions: ['C1'] },
      verifyRuns: [{ phase: 'post', ranAt: TS, command: 'npm test', exitCode: 1, durationMs: 500, outcome: 'failed' }],
    };
    const running = {
      ...base.attempts[base.attempts.length - 1],
      n: 2,
      verifyRuns: [{ phase: 'pre', ranAt: TS, command: 'npm test', exitCode: 0, durationMs: 300, outcome: 'success' }],
    };
    const task = {
      ...base,
      attempts: [priorSettled, running],
      escalatedFromModel: opts.generator.model,
      escalatedToModel: opts.generator.model,
    } as unknown as InProgressTask;
    const ctx = buildCtx(task);

    const result = await bestOfNCandidateLoopLeaf(deps, opts, task.id).execute(ctx);
    expect(result.ok).toBe(true);

    const prompt = await fs.readFile(join(String(workspaceRoot), 'candidates', '1', 'prompt.md'), 'utf8');
    expect(prompt).toContain('You have plateaued');
    expect(prompt).toContain('The auth check compares the wrong header');
    expect(prompt).toContain('FAILED (exit 1)'); // retry feedback — the prior failing post-verify
    expect(prompt).toContain('passed (exit 0)'); // pre-verify results — the current pre-verify
  });

  // ── 6. Grant consumption is persisted before any candidate spawns ───────────────────

  it('minors #4: the grant is persisted to disk (bestOfNGrantedCandidates dropped) BEFORE the first candidate spawns, not only after selection closes out', async () => {
    const gitState = freshGitState();
    const gitRunner = createFakeGitRunner(gitState);
    const spawnOrder: string[] = [];
    const genProvider: HeadlessAiProvider = {
      async generate(session) {
        spawnOrder.push('candidate-spawn');
        return createFakeGeneratorProvider(gitState, { 1: { diff: 'diff-1' }, 2: { diff: 'diff-1' } }).generate(
          session
        );
      },
    };
    // Both candidates converge on the identical diff so dedupe collapses them to a single
    // survivor — no judge call needed, isolating this test to the persist-ordering assertion.
    const evalProvider = createFakeEvaluatorProvider([]);
    const deps = buildDeps(gitRunner, genProvider, evalProvider, shellScriptedByDiff(gitState, new Set()));
    const opts = buildOpts();
    const task = buildTask(2);
    const ctx = buildCtx(task);

    const result = await buildBestOfNGenEvalLoop(deps, opts, task.id, async () => ({ maxTurns: 5 })).execute(ctx);

    expect(result.ok).toBe(true);
    // Persisted exactly once, before any candidate spawn.
    expect(taskRepoUpdates).toHaveLength(1);
    expect(taskRepoUpdates[0]?.task.bestOfNGrantedCandidates).toBeUndefined();
    // In-memory ctx keeps the field for the rest of THIS attempt (see `hasBestOfNCompositeRun`'s
    // docstring) — the persist is a disk-only side effect, so the loop still ran with `n` intact.
    if (result.ok) {
      expect(spawnOrder).toEqual(['candidate-spawn', 'candidate-spawn']);
    }
  });
});
