/**
 * Integration tests for the distill SUB-RUNNER adapter composed into BOTH close
 * paths — the explicit close-sprint flow and the review flow's auto-done path.
 *
 * Exercises {@link createDistillStep} via the real close-sprint / review flows against a tmpdir,
 * a fake `InteractiveAiProvider`, an on-disk `WriteFile`, and a scripted `InteractivePrompt`.
 * Asserts the four distill-composition acceptance fences:
 *  - opt-in NO (`distillRequested === false`) → the inner `distill-gate` guard skips the body
 *    (no AI spawn, no file touch) AND the sprint still transitions to `done`.
 *  - opt-in YES → the distill step fires BEFORE the transition (trace order proves it).
 *  - the review-flow AUTO-DONE path (empty round → transition) fires the SAME sub-chain.
 *  - abort mid-distill on EITHER path → `AbortError` propagates and the sprint stays `review`
 *    (re-runnable).
 *  - a NON-abort distill failure → warning logged, sprint STILL transitions to `done`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AiSettings } from '@src/domain/entity/settings.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { DistillLearningsDeps } from '@src/application/flows/_shared/memory/distill-learnings.ts';
import type { DistillStepOpts } from '@src/application/flows/_shared/memory/distill-step.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import {
  absolutePath,
  FIXED_LATER,
  isoTimestamp,
  makeRepository,
  makeReviewSprint,
  projectId,
  slug,
} from '@tests/fixtures/domain.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { buildSluggedName } from '@src/integration/persistence/storage.ts';

const FIXED_NOW = isoTimestamp('2026-05-30T10:00:00.000Z');
const PROJECT_ID = projectId('01900000-0000-7000-8000-0000000000aa');
const PROJECT_SLUG = slug('demo-project');
/** The slugged per-project memory dir distill now writes/reads via the direct-build path. */
const MEMORY_DIR = buildSluggedName(String(PROJECT_ID), String(PROJECT_SLUG));

const record = (over: Partial<LearningRecord> = {}): LearningRecord => ({
  v: 1,
  id: 'id-1',
  text: 'always run lint before committing',
  repo: '/repos/app',
  repoName: 'app',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-05-29T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

const allClaudeRow = { provider: 'claude-code' as const, model: 'claude-sonnet-4-6' };
const allClaude: AiSettings = {
  refine: allClaudeRow,
  plan: allClaudeRow,
  implement: { generator: allClaudeRow, evaluator: allClaudeRow },
  readiness: allClaudeRow,
  ideate: allClaudeRow,
  createPr: allClaudeRow,
};

/** Fake interactive AI: records every spawn and writes the proposal to `outputFile` (or aborts). */
const fakeInteractiveAi = (opts: {
  readonly calls: InteractiveAiProviderInput[];
  readonly abort?: boolean;
  readonly fail?: boolean;
}): InteractiveAiProvider => ({
  async run(input) {
    opts.calls.push(input);
    if (opts.abort) return Result.error(new AbortError({ elementName: 'distill-propose' }));
    if (opts.fail) {
      return Result.error(
        new InvalidStateError({
          entity: 'distill',
          currentState: 'spawn',
          attemptedAction: 'run',
          message: 'fake AI failure (non-abort)',
        })
      );
    }
    await fs.writeFile(
      String(input.outputFile),
      '# Distilled context\n\n## Learnings (ralphctl)\n\n- always run lint before committing\n',
      'utf8'
    );
    return Result.ok({});
  },
});

const confirmAlways = (value: boolean): InteractivePrompt => ({
  async askText() {
    return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askText not scripted' }));
  },
  async askTextArea() {
    return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
  },
  async askChoice<T>(): Promise<Result<T, DomainError>> {
    return Result.error(
      new ValidationError({ field: 'fake', value: null, message: 'askChoice not scripted' })
    ) as Result<T, DomainError>;
  },
  async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
    return Result.ok([]);
  },
  async askConfirm() {
    return Result.ok(value);
  },
});

/** Logger that records warn-level lines so the best-effort fallback is observable in tests. */
const recordingLogger = (): { logger: Logger; warns: () => readonly string[] } => {
  const warns: string[] = [];
  const make = (): Logger => ({
    debug() {},
    info() {},
    warn(message: string, _meta?: LogMeta) {
      void _meta;
      warns.push(message);
    },
    error() {},
    named: () => make(),
  });
  return { logger: make(), warns: () => warns };
};

const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
  let current = initial;
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

describe('createDistillStep composed into the close paths', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let memoryRoot: AbsolutePath;
  let distillRoot: AbsolutePath;
  let repoPath: string;
  let ledgerPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    memoryRoot = absolutePath(join(String(root.root), 'memory'));
    distillRoot = absolutePath(join(String(root.root), 'distill'));
    repoPath = join(String(root.root), 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    ledgerPath = join(String(memoryRoot), MEMORY_DIR, 'learnings.ndjson');
    await fs.mkdir(join(String(memoryRoot), MEMORY_DIR), { recursive: true });
    await fs.writeFile(ledgerPath, serializeLearningRecord(record({ id: 'a' })), 'utf8');
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildDistill = (
    over: Partial<{ ai: InteractiveAiProvider; interactive: InteractivePrompt; logger: Logger }> = {}
  ): { deps: DistillLearningsDeps; opts: DistillStepOpts } => ({
    deps: {
      interactiveAiFor: () => over.ai ?? fakeInteractiveAi({ calls: [] }),
      runInTerminal: passthroughRunInTerminal,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      interactive: over.interactive ?? confirmAlways(true),
      writeFile: createAtomicWriteFile(),
      logger: over.logger ?? recordingLogger().logger,
      clock: () => FIXED_NOW,
    },
    opts: {
      projectId: PROJECT_ID,
      projectSlug: PROJECT_SLUG,
      memoryRoot,
      distillRoot,
      repository: makeRepository({ path: repoPath, name: 'repo' }),
      ai: allClaude,
    },
  });

  const claudeMdExists = async (): Promise<boolean> => {
    try {
      return (await fs.stat(join(repoPath, 'CLAUDE.md'))).isFile();
    } catch {
      return false;
    }
  };

  it('opt-in NO → distill-gate skips body, no AI spawn, no file touch, sprint still transitions to done', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: recordingLogger().logger,
      appendFile: append.fn,
      progressFile: absolutePath(join(String(root.root), 'progress.md')),
      distill: buildDistill({ ai: fakeInteractiveAi({ calls }) }),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-no',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(sprintRepo.current().status).toBe('done');
    // Guard skipped the body — no AI spawn, no context file.
    expect(calls).toHaveLength(0);
    expect(await claudeMdExists()).toBe(false);
  });

  it('opt-in YES → distill fires BEFORE the transition (trace order) and the context file lands', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: recordingLogger().logger,
      appendFile: append.fn,
      progressFile: absolutePath(join(String(root.root), 'progress.md')),
      distill: buildDistill({ ai: fakeInteractiveAi({ calls }) }),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-yes',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: true },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(sprintRepo.current().status).toBe('done');
    // Exactly one AI spawn for the single distinct provider, and the native file landed.
    expect(calls).toHaveLength(1);
    expect(await claudeMdExists()).toBe(true);
    // The distill write ran BEFORE the transition leaf — trace order proves the composition point.
    const names = runner.trace.map((t) => t.elementName);
    const writeIdx = names.indexOf('distill-write-claude-code');
    const transitionIdx = names.indexOf('transition-sprint-to-done');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(transitionIdx).toBeGreaterThan(writeIdx);
  });

  it('abort mid-distill on the close path → AbortError propagates, sprint stays review (re-runnable)', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: recordingLogger().logger,
      appendFile: append.fn,
      progressFile: absolutePath(join(String(root.root), 'progress.md')),
      distill: buildDistill({ ai: fakeInteractiveAi({ calls, abort: true }) }),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-abort',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: true },
    });
    await runner.start();

    // AbortError is the one error chains forward transparently.
    expect(runner.status).toBe('aborted');
    // The sprint never transitioned — distill ran while it was still `review`, so it's re-runnable.
    expect(sprintRepo.current().status).toBe('review');
    // The transition leaf never ran (sequential aborts the remainder before reaching it).
    expect(runner.trace.some((t) => t.elementName === 'transition-sprint-to-done' && t.status === 'completed')).toBe(
      false
    );
  });

  it('non-abort distill failure → warning logged, sprint STILL transitions to done (best-effort)', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const log = recordingLogger();
    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: recordingLogger().logger,
      appendFile: append.fn,
      progressFile: absolutePath(join(String(root.root), 'progress.md')),
      distill: buildDistill({ ai: fakeInteractiveAi({ calls, fail: true }), logger: log.logger }),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-fail',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: true },
    });
    await runner.start();

    // Best-effort: a non-abort distill failure does NOT block the close.
    expect(runner.status).toBe('completed');
    expect(sprintRepo.current().status).toBe('done');
    // The fallback emitted a warn line so the failure is observable.
    expect(log.warns().some((w) => /distill failed/i.test(w))).toBe(true);
  });
});

// ── Review AUTO-DONE path ─────────────────────────────────────────────────────────────────────
// The review flow transitions the sprint to `done` automatically when the user submits an empty
// round. The distill step must fire on THAT path too — the same opt-in sub-chain runs
// whether the user closes explicitly or lets review auto-finish.

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

/** Review provider: writes one terminal `task-complete` into outputDir/signals.json per round. */
const reviewProvider: HeadlessAiProvider = {
  async generate(session) {
    const signals = [{ type: 'task-complete' as const, timestamp: FIXED_NOW }];
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return Result.error(wrote.error);
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0, sessionId: 'sess-1' });
  },
};

/**
 * Interactive prompt for the review flow: `askTextArea` drives the feedback round (an empty body
 * terminates → auto-done), while `askConfirm` answers the distill gate. The distill confirm runs
 * at LAUNCH time (not inside the chain), so inside the chain only `askTextArea` is consulted; we
 * still wire `askConfirm` so the per-tool distill confirm leaf resolves.
 */
const reviewInteractive = (bodies: readonly string[], confirm: boolean): InteractivePrompt => {
  let i = 0;
  return {
    async askText() {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askText not used' }));
    },
    async askTextArea() {
      return Result.ok(bodies[i++] ?? '');
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askChoice not used' })) as Result<
        T,
        DomainError
      >;
    },
    async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
      return Result.ok([]);
    },
    async askConfirm() {
      return Result.ok(confirm);
    },
  };
};

describe('createDistillStep on the review auto-done path', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let memoryRoot: AbsolutePath;
  let distillRoot: AbsolutePath;
  let repoPath: string;
  let reviewRoot: AbsolutePath;
  let feedbackFile: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    memoryRoot = absolutePath(join(String(root.root), 'memory'));
    distillRoot = absolutePath(join(String(root.root), 'distill'));
    reviewRoot = absolutePath(join(String(root.root), 'review'));
    feedbackFile = absolutePath(join(String(root.root), 'feedback.md'));
    repoPath = join(String(root.root), 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(join(String(memoryRoot), MEMORY_DIR), { recursive: true });
    await fs.writeFile(
      join(String(memoryRoot), MEMORY_DIR, 'learnings.ndjson'),
      serializeLearningRecord(record({ id: 'a' })),
      'utf8'
    );
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const distillFor = (ai: InteractiveAiProvider): { deps: DistillLearningsDeps; opts: DistillStepOpts } => ({
    deps: {
      interactiveAiFor: () => ai,
      runInTerminal: passthroughRunInTerminal,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      interactive: confirmAlways(true),
      writeFile: createAtomicWriteFile(),
      logger: recordingLogger().logger,
      clock: () => FIXED_NOW,
    },
    opts: {
      projectId: PROJECT_ID,
      projectSlug: PROJECT_SLUG,
      memoryRoot,
      distillRoot,
      repository: makeRepository({ path: repoPath, name: 'repo' }),
      ai: allClaude,
    },
  });

  const buildReviewFlow = (
    sprintRepo: SprintRepository,
    sprintId: SprintId,
    distill: { deps: DistillLearningsDeps; opts: DistillStepOpts },
    interactive: InteractivePrompt
  ) =>
    createReviewFlow(
      {
        sprintRepo,
        taskRepo: noopTaskRepo,
        provider: reviewProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus: createInMemoryEventBus(),
        logger: recordingLogger().logger,
        clock: () => FIXED_LATER,
        interactive,
        gitRunner: cleanTreeRunner,
        shellScriptRunner: noopShell,
        fileLocker: createFileLocker(),
        locksRoot: absolutePath(String(root.root)),
        appendFile: createAppendFile(),
        model: 'claude-opus-4-8',
        distill,
      },
      {
        sprintId,
        sprintDir: absolutePath(String(root.root)),
        reviewRoot,
        commitCwd: absolutePath(repoPath),
        additionalRoots: [absolutePath(repoPath)],
        repositoriesBlock: `- \`${repoPath}\` (repo)`,
        feedbackFile,
      }
    );

  const claudeMdExists = async (): Promise<boolean> => {
    try {
      return (await fs.stat(join(repoPath, 'CLAUDE.md'))).isFile();
    } catch {
      return false;
    }
  };

  it('auto-done path fires the SAME distill sub-chain before the transition; context file lands', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    // Empty first round → immediate termination → auto-done. distillRequested=true.
    const flow = buildReviewFlow(
      sprintRepo.repo,
      sprintRepo.current().id,
      distillFor(fakeInteractiveAi({ calls })),
      reviewInteractive([], true)
    );
    const runner = createRunner<ReviewCtx>({
      id: 'r-review-distill-yes',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: true },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(sprintRepo.current().status).toBe('done');
    // The distill sub-chain fired on the auto-done path — one AI spawn, native file landed.
    expect(calls).toHaveLength(1);
    expect(await claudeMdExists()).toBe(true);
    // Distill write precedes the transition.
    const names = runner.trace.map((t) => t.elementName);
    expect(names.indexOf('distill-write-claude-code')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('transition-sprint-to-done')).toBeGreaterThan(names.indexOf('distill-write-claude-code'));
  });

  it('opt-out on the auto-done path → gate skips, no AI spawn, sprint still transitions', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const flow = buildReviewFlow(
      sprintRepo.repo,
      sprintRepo.current().id,
      distillFor(fakeInteractiveAi({ calls })),
      reviewInteractive([], false)
    );
    const runner = createRunner<ReviewCtx>({
      id: 'r-review-distill-no',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(sprintRepo.current().status).toBe('done');
    expect(calls).toHaveLength(0);
    expect(await claudeMdExists()).toBe(false);
  });

  it('abort mid-distill on the review path → AbortError propagates, sprint stays review (re-runnable)', async () => {
    const sprintRepo = inMemorySprintRepo(makeReviewSprint());
    const calls: InteractiveAiProviderInput[] = [];
    const flow = buildReviewFlow(
      sprintRepo.repo,
      sprintRepo.current().id,
      distillFor(fakeInteractiveAi({ calls, abort: true })),
      reviewInteractive([], true)
    );
    const runner = createRunner<ReviewCtx>({
      id: 'r-review-distill-abort',
      element: flow,
      initialCtx: { sprintId: sprintRepo.current().id, distillRequested: true },
    });
    await runner.start();

    expect(runner.status).toBe('aborted');
    // Distill ran while the sprint was still `review`; the abort leaves it un-closed + re-runnable.
    expect(sprintRepo.current().status).toBe('review');
    expect(runner.trace.some((t) => t.elementName === 'transition-sprint-to-done' && t.status === 'completed')).toBe(
      false
    );
  });
});
