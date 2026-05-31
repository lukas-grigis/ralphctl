import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { ReviewSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_PROJECT_ID,
  isoTimestamp,
  makeApprovedTicket,
  makeRepository,
  makeReviewSprint,
} from '@tests/fixtures/domain.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { AskConfirmInput, Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

void makeApprovedTicket;
const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');
const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
  let current: Sprint = initial;
  return {
    repo: {
      async findById(id: SprintId) {
        if (current.id === id) return Result.ok(current);
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      },
      async save(sprint: Sprint) {
        current = sprint;
        return Result.ok(undefined);
      },
    } as SprintRepository,
    current: () => current,
  };
};

const noopTaskRepo: TaskRepository = {
  async findBySprintId() {
    return Result.ok([]);
  },
  async findById() {
    return Result.error(new NotFoundError({ entity: 'task', id: 'missing' }));
  },
  async update() {
    return Result.ok(undefined);
  },
  async saveAll() {
    return Result.ok(undefined);
  },
};

const okGit = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr: '', exitCode });

const cleanTreeRunner: GitRunner = {
  async run() {
    return okGit('');
  },
};

const noopShell: ShellScriptRunner = {
  async run() {
    return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
  },
};

const fakeProvider: HeadlessAiProvider = {
  async generate(session) {
    // audit-[09]: the AI writes the contract envelope into `outputDir/signals.json` directly.
    // The review-round contract accepts exactly one terminal signal per round.
    const signals = [{ type: 'task-complete' as const, timestamp: NOW }];
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return Result.error(wrote.error);
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0, sessionId: 'sess-1' });
  },
};

const unusedAsk = (method: string) => async (): Promise<never> => {
  throw new Error(`scriptedInteractive: ${method} not used in review tests`);
};

const scriptedInteractive = (bodies: readonly string[]): InteractivePrompt => {
  let i = 0;
  return {
    askText: unusedAsk('askText'),
    async askTextArea(_prompt: string) {
      void _prompt;
      const body = bodies[i++];
      // No more scripted bodies → terminate via an empty submission (use case treats an empty
      // round as termination). Mirrors what v1's empty editor save produced.
      return Result.ok(body ?? '');
    },
    async askChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>) {
      void _prompt;
      void _options;
      throw new Error('scriptedInteractive: askChoice not used in review tests');
    },
    askMultiChoice: unusedAsk('askMultiChoice'),
    async askConfirm(_input: AskConfirmInput) {
      void _input;
      throw new Error('scriptedInteractive: askConfirm not used in review tests');
    },
  };
};

const abortingInteractive = (): InteractivePrompt => ({
  askText: unusedAsk('askText'),
  async askTextArea() {
    return Result.error(new AbortError({ elementName: 'interactive.textarea', reason: 'user pressed Esc' }));
  },
  async askChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>) {
    void _prompt;
    void _options;
    throw new Error('scriptedInteractive: askChoice not used in review tests');
  },
  askMultiChoice: unusedAsk('askMultiChoice'),
  async askConfirm(_input: AskConfirmInput) {
    void _input;
    throw new Error('scriptedInteractive: askConfirm not used in review tests');
  },
});

/**
 * A buildable-but-never-executed distill composition. With `distillRequested: false` the chain's
 * `distill-gate` guard skips the body, so the inner leaves never run — but the sub-chain is built
 * eagerly, so the deps must be shaped enough to construct (stub AI / write / template ports the
 * gate prevents from ever firing). Wiring it makes the `distill-learnings` skipped step appear in
 * the trace so the step-order fence can lock it immediately before the transition.
 */
const stubDistill = (): NonNullable<ReviewDeps['distill']> => ({
  deps: {
    interactiveAiFor: () => ({}) as never,
    runInTerminal: (() => {}) as never,
    templateLoader: {} as never,
    interactive: {} as never,
    writeFile: (() => {}) as never,
    logger: noopLogger,
    clock: () => FIXED_LATER,
  } as never,
  opts: {
    projectId: FIXED_PROJECT_ID,
    memoryRoot: absolutePath('/tmp/memory'),
    distillRoot: absolutePath('/tmp/distill'),
    repository: makeRepository(),
    ai: DEFAULT_SETTINGS.ai,
  },
});

describe('createReviewFlow', () => {
  let cleanupFns: Array<() => Promise<void>>;
  beforeEach(() => {
    cleanupFns = [];
  });
  afterEach(async () => {
    for (const fn of cleanupFns) await fn();
  });

  const buildSprint = (): ReviewSprint => makeReviewSprint();

  it('runs one feedback round and transitions sprint to done', async () => {
    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-review-')));
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const feedbackFile = absolutePath(join(dir, 'feedback.md'));
    const sprint = buildSprint();
    const repo = inMemorySprintRepo(sprint);

    // First editor invocation writes the round-1 body; second leaves the (round-2) body
    // empty → termination round → loop exits cleanly.
    const interactive = scriptedInteractive(['fix the foo bar in baz.ts']);

    const flow = createReviewFlow(
      {
        sprintRepo: repo.repo,
        taskRepo: noopTaskRepo,
        provider: fakeProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        interactive,
        gitRunner: cleanTreeRunner,
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(dir),
        appendFile: createAppendFile(),
        model: 'claude-opus-4-8',
      },
      {
        sprintId: sprint.id,
        reviewRoot: absolutePath(join(dir, 'review')),
        commitCwd: FAKE_CWD,
        additionalRoots: [FAKE_CWD],
        repositoriesBlock: `- \`${String(FAKE_CWD)}\` (fake-cwd)`,
        feedbackFile,
      }
    );

    const runner = createRunner({
      id: 'r-review',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(repo.current().status).toBe('done');
  });

  it('exits without transition when the user aborts via editor non-zero', async () => {
    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-review-')));
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const feedbackFile = absolutePath(join(dir, 'feedback.md'));
    const sprint = buildSprint();
    const repo = inMemorySprintRepo(sprint);

    const interactive = abortingInteractive();

    const flow = createReviewFlow(
      {
        sprintRepo: repo.repo,
        taskRepo: noopTaskRepo,
        provider: fakeProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        interactive,
        gitRunner: cleanTreeRunner,
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(dir),
        appendFile: createAppendFile(),
        model: 'claude-opus-4-8',
      },
      {
        sprintId: sprint.id,
        reviewRoot: absolutePath(join(dir, 'review')),
        commitCwd: FAKE_CWD,
        additionalRoots: [FAKE_CWD],
        repositoriesBlock: `- \`${String(FAKE_CWD)}\` (fake-cwd)`,
        feedbackFile,
      }
    );

    const runner = createRunner({
      id: 'r-review-abort',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(repo.current().status).toBe('review');
  });

  it('roots the AI session at <reviewRoot>/round-1 and mounts every sprint-affected repo on a multi-repo sprint', async () => {
    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-review-')));
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const feedbackFile = absolutePath(join(dir, 'feedback.md'));
    const reviewRoot = absolutePath(join(dir, 'review'));
    const repoA = absolutePath('/tmp/ralph/repo-a');
    const repoB = absolutePath('/tmp/ralph/repo-b');
    const repoC = absolutePath('/tmp/ralph/repo-c');
    const sprint = buildSprint();
    const repo = inMemorySprintRepo(sprint);

    // Capture the AI session descriptor so we can assert routing without running a real CLI.
    // One round → one spawn. The fake provider stays compatible with the contract: writes
    // a single terminal `task-complete` into outputDir/signals.json before returning.
    let captured: Parameters<HeadlessAiProvider['generate']>[0] | undefined;
    const capturingProvider: HeadlessAiProvider = {
      async generate(session) {
        captured = session;
        const signals = [{ type: 'task-complete' as const, timestamp: NOW }];
        const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
        if (!wrote.ok) return Result.error(wrote.error);
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0, sessionId: 'sess-multi' });
      },
    };
    // One round body, then empty → loop terminates after the spawn.
    const interactive = scriptedInteractive(['adjust the foo handler in repo-c so it returns null on missing input']);

    const flow = createReviewFlow(
      {
        sprintRepo: repo.repo,
        taskRepo: noopTaskRepo,
        provider: capturingProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        interactive,
        gitRunner: cleanTreeRunner,
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(dir),
        appendFile: createAppendFile(),
        model: 'claude-opus-4-8',
      },
      {
        sprintId: sprint.id,
        reviewRoot,
        // Commit / verify still target a single repo today. The launcher picks the first
        // sprint-affected repo; the test mirrors that.
        commitCwd: repoA,
        // Three repos mounted — the user's feedback names repo-c (a non-first repo), so this
        // is exactly the case the bug regressed: before the fix, only repo-a would have been
        // visible and the AI would have emitted a `task-blocked` signal.
        additionalRoots: [repoA, repoB, repoC],
        repositoriesBlock: [
          '- `/tmp/ralph/repo-a` (repo-a)',
          '- `/tmp/ralph/repo-b` (repo-b)',
          '- `/tmp/ralph/repo-c` (repo-c)',
        ].join('\n'),
        feedbackFile,
      }
    );

    const runner = createRunner({
      id: 'r-review-multi',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // The AI session was spawned exactly once and routed correctly:
    expect(captured).toBeDefined();
    if (!captured) return;
    // cwd is the per-round dir under <sprintDir>/review/, not any repo — symmetric multi-repo
    // pattern, mirrors plan. round-1 is the first round about to be acted on.
    expect(String(captured.cwd)).toBe(join(String(reviewRoot), 'round-1'));
    // Every sprint-affected repo is mounted as an additionalRoot. Order preserved.
    expect(captured.additionalRoots?.map(String)).toEqual([String(repoA), String(repoB), String(repoC)]);
    // outputDir matches the round dir — the signals.json contract reads from there.
    expect(String(captured.outputDir)).toBe(join(String(reviewRoot), 'round-1'));
    // The harness must have materialised the round dir + the prompt before the spawn.
    const promptOnDisk = await fs.readFile(join(String(reviewRoot), 'round-1', 'prompt.md'), 'utf8');
    // Every mounted repo path surfaces in the rendered prompt — this is what unblocks the AI
    // when feedback targets a non-first repo.
    expect(promptOnDisk).toContain('/tmp/ralph/repo-a');
    expect(promptOnDisk).toContain('/tmp/ralph/repo-b');
    expect(promptOnDisk).toContain('/tmp/ralph/repo-c');
  });

  it('terminates immediately on empty round 1 (user opened editor and saved nothing)', async () => {
    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-review-')));
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const feedbackFile = absolutePath(join(dir, 'feedback.md'));
    const sprint = buildSprint();
    const repo = inMemorySprintRepo(sprint);

    // User submits an empty body → empty round → termination → sprint to done.
    const interactive = scriptedInteractive([]);

    const flow = createReviewFlow(
      {
        sprintRepo: repo.repo,
        taskRepo: noopTaskRepo,
        provider: fakeProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        clock: () => FIXED_LATER,
        interactive,
        gitRunner: cleanTreeRunner,
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(dir),
        appendFile: createAppendFile(),
        model: 'claude-opus-4-8',
        distill: stubDistill(),
      },
      {
        sprintId: sprint.id,
        reviewRoot: absolutePath(join(dir, 'review')),
        commitCwd: FAKE_CWD,
        additionalRoots: [FAKE_CWD],
        repositoriesBlock: `- \`${String(FAKE_CWD)}\` (fake-cwd)`,
        feedbackFile,
      }
    );

    const runner = createRunner({
      id: 'r-review-empty',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Step-order fence for the auto-done path (empty round 1 → transition). The distill step
    // (its `distill-gate` guard's skipped body name, `distill-learnings`) MUST sit immediately
    // before `transition-sprint-to-done` — the sprint cannot flip to done before distill runs.
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'ensure-feedback-file',
      'review-round',
      'distill-learnings',
      'transition-sprint-to-done',
    ]);
    expect(repo.current().status).toBe('done');
  });
});
