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
  isoTimestamp,
  makeApprovedTicket,
  makeReviewSprint,
} from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AskConfirmInput } from '@src/business/interactive/prompt.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
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
    const signals = [
      { type: 'task-verified' as const, output: 'tests pass', timestamp: NOW },
      { type: 'task-complete' as const, timestamp: NOW },
    ];
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
        model: 'claude-opus-4-7',
      },
      { sprintId: sprint.id, cwd: FAKE_CWD, feedbackFile }
    );

    const runner = createRunner({
      id: 'r-review',
      element: flow,
      initialCtx: { sprintId: sprint.id } satisfies ReviewCtx,
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
        model: 'claude-opus-4-7',
      },
      { sprintId: sprint.id, cwd: FAKE_CWD, feedbackFile }
    );

    const runner = createRunner({
      id: 'r-review-abort',
      element: flow,
      initialCtx: { sprintId: sprint.id } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(repo.current().status).toBe('review');
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
        model: 'claude-opus-4-7',
      },
      { sprintId: sprint.id, cwd: FAKE_CWD, feedbackFile }
    );

    const runner = createRunner({
      id: 'r-review-empty',
      element: flow,
      initialCtx: { sprintId: sprint.id } satisfies ReviewCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(repo.current().status).toBe('done');
  });
});
