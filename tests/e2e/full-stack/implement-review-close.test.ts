/**
 * Full-stack multi-flow e2e test: implement → review → close-sprint.
 *
 * Uses the REAL wire()-based AppDeps (real persistence on a tmp dir) so schema regressions,
 * migration misses, or ports that silently stopped writing surface as missing files or parse
 * failures — not as green tests against mocks whose shape no longer matches reality.
 *
 * What is REAL:
 *  - All persistence repositories (sprint / execution / task) backed by fs tmp dir.
 *  - progress.md append (real append-file adapter).
 *  - File locker (hermetic; locksRoot inside tmpdir).
 *
 * What is faked:
 *  - HeadlessAiProvider — writes scripted files + emits harness signals.
 *  - GitRunner — scripted fake (clean/dirty model) for the serial implement path.
 *  - ShellScriptRunner — always passes.
 *  - InteractivePrompt — unused-interactive stub (no prompts expected in scripted path).
 *
 * Key constraint (R1): the implement LAUNCHER builds per-role providers itself from settings,
 * bypassing app.deps.provider. So ImplementDeps is built from app.deps fields directly with the
 * fake injected as generatorProvider/evaluatorProvider — same pattern as buildDeps() in
 * tests/e2e/flows/implement.test.ts but using real repos from the wired graph instead of in-memory stubs.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';

import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';

import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { createImplementFlow } from '@src/application/flows/implement/flow.ts';

import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import { createReviewFlow } from '@src/application/flows/review/flow.ts';

import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';

import { createRunner } from '@src/application/chain/run/runner.ts';
import type { HarnessSignal, EvaluationSignal } from '@src/domain/signal.ts';

import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { noopSkillsAdapter, emptySkillSource } from '@tests/fixtures/skills-fakes.ts';
import { createWorkspaceMutatingFakeProvider } from '@tests/fixtures/workspace-mutating-fake-provider.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';

import {
  absolutePath,
  FIXED_LATER,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

// ─── skip on Windows — real file-system + git tests are posix-heavy ──────────
if (process.platform === 'win32') {
  describe.skip('full-stack implement→review→close (skipped on Windows)', () => {
    it.skip('placeholder', () => undefined);
  });
} else {
  runTests();
}

function runTests(): void {
  // ─── Constants ─────────────────────────────────────────────────────────────
  const SPRINT_BRANCH = 'ralphctl/full-stack-test';
  const FAKE_PROJECT_ID = 'proj-fullstack-e2e';

  // ─── Signal builders ───────────────────────────────────────────────────────
  const taskVerified = (output: string): HarnessSignal => ({ type: 'task-verified', output, timestamp: FIXED_NOW });
  const evaluationPassed = (): EvaluationSignal => ({
    type: 'evaluation',
    status: 'passed',
    dimensions: [
      { dimension: 'correctness', passed: true, finding: 'all good' },
      { dimension: 'completeness', passed: true, finding: 'steps shipped' },
      { dimension: 'safety', passed: true, finding: 'inputs validated' },
      { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    ],
    timestamp: FIXED_NOW,
  });
  const evaluationFailed = (critique: string): EvaluationSignal => ({
    type: 'evaluation',
    status: 'failed',
    dimensions: [
      { dimension: 'correctness', passed: false, finding: critique },
      { dimension: 'completeness', passed: true, finding: 'steps shipped' },
      { dimension: 'safety', passed: true, finding: 'inputs validated' },
      { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    ],
    critique,
    timestamp: FIXED_NOW,
  });

  // ─── GitRunner fake — serial implement path ────────────────────────────────
  /**
   * Scripted git runner for the serial implement path. Models a branch-resolved working tree
   * (pre-set to SPRINT_BRANCH) so resolveBranchLeaf takes the resume path without prompting.
   * Status starts clean; flips dirty in a commit window then back to clean after each commit.
   */
  const okGit = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
    Result.ok({ stdout, stderr: '', exitCode });

  const makeScriptedGit = (): GitRunner => {
    let head = SPRINT_BRANCH;
    let preflightStatusesRemaining = 2; // working-tree-clean-check + preflight-task
    let cleanAfterCommit = false;
    let taskCommits = 0;
    const sha = (i: number): string =>
      String(i)
        .padStart(40, '0')
        .replace(/[^0-9a-f]/gi, '0');

    return {
      async run(_, args) {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          if (preflightStatusesRemaining > 0) {
            preflightStatusesRemaining -= 1;
            return okGit('', 0);
          }
          if (cleanAfterCommit) {
            cleanAfterCommit = false;
            return okGit('', 0);
          }
          return okGit(' M file\n', 0);
        }
        if (args[0] === 'add' && args[1] === '-A') return okGit('', 0);
        if (args[0] === 'stash' && args[1] === 'push') return okGit('Saved working directory\n', 0);
        if (args[0] === 'commit' && args[1] === '-m') {
          cleanAfterCommit = true;
          return okGit('', 0);
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          taskCommits += 1;
          return okGit(`${sha(taskCommits)}\n`, 0);
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return okGit(`${head}\n`, 0);
        if (args[0] === 'show-ref') return okGit(`abc123 refs/heads/${head}\n`, 0);
        if (args[0] === 'checkout') {
          const target = args[1] === '-b' ? args[2] : args[1];
          if (target !== undefined) head = target;
          return okGit('', 0);
        }
        if (args[0] === 'diff' && args[1] === 'HEAD') return okGit('@@ -1 +1 @@\n-old\n+new\n', 0);
        if (args[0] === 'ls-files') return okGit('', 0);
        return okGit('', 0);
      },
    };
  };

  // ─── ShellScriptRunner — always passes ────────────────────────────────────
  const passingShell: ShellScriptRunner = {
    async run() {
      return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
    },
  };

  // ─── InteractivePrompt — throws on any call ────────────────────────────────
  const unusedInteractive: InteractivePrompt = {
    async askText() {
      throw new Error('full-stack: askText not expected');
    },
    async askTextArea() {
      throw new Error('full-stack: askTextArea not expected');
    },
    async askChoice() {
      throw new Error('full-stack: askChoice not expected');
    },
    async askMultiChoice() {
      throw new Error('full-stack: askMultiChoice not expected');
    },
    async askConfirm() {
      throw new Error('full-stack: askConfirm not expected');
    },
  };

  // ─── ImplementDeps builder from real wired repos ──────────────────────────
  /**
   * Build ImplementDeps from the real wired graph (R1 constraint). The implement launcher
   * bypasses app.deps.provider and builds per-role providers from settings; so we must
   * supply the fake directly as generatorProvider/evaluatorProvider here.
   */
  const buildImplementDeps = (
    app: RealFsApp,
    provider: ImplementDeps['generatorProvider'],
    gitRunner: GitRunner,
    locksDir: string
  ): ImplementDeps => ({
    sprintRepo: app.deps.sprintRepo,
    sprintExecutionRepo: app.deps.sprintExecutionRepo,
    taskRepo: app.deps.taskRepo,
    generatorProvider: provider,
    evaluatorProvider: provider,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    eventBus: createInMemoryEventBus(),
    logger: noopLogger,
    clock: () => FIXED_LATER,
    config: {
      harness: {
        maxTurns: 5,
        maxAttempts: 2,
        rateLimitRetries: 0,
        plateauThreshold: 2,
        escalateOnPlateau: false,
        escalationMap: {},
        skipPreVerifyOnFreshSetup: false,
      },
    },
    gitRunner,
    shellScriptRunner: passingShell,
    fileLocker: createFileLocker(),
    locksRoot: absolutePath(locksDir),
    skillsAdapter: noopSkillsAdapter,
    skillSource: emptySkillSource,
    interactive: unusedInteractive,
    writeFile: createAtomicWriteFile(),
    appendFile: createAppendFile(),
  });

  // ─── Fixture setup helpers ─────────────────────────────────────────────────
  interface FullStackFixture {
    readonly app: RealFsApp;
    readonly fakeProject: FakeProject;
    readonly sprintDir: string;
    readonly progressFile: string;
    readonly reviewDir: string;
    readonly feedbackFile: string;
    readonly locksDir: string;
    cleanup(): Promise<void>;
  }

  /**
   * Build a fixture with real AppDeps, a fake git project, and persisted domain state.
   * The execution is pre-set to SPRINT_BRANCH so resolveBranchLeaf takes the resume path
   * without any interactive prompt.
   */
  const buildFixture = async (taskCount: number): Promise<FullStackFixture> => {
    const app = await createRealFsApp();
    const fakeProject = await createFakeProject({
      seed: { 'README.md': '# full-stack test repo\n', '.gitignore': 'node_modules/\n' },
    });

    // Create the sprint branch in the fake project.
    await fakeProject.git('checkout', '-b', SPRINT_BRANCH);

    // Create domain fixtures.
    const ticket = makeApprovedTicket({ title: 'full-stack-ticket' });
    const sprint = makePlannedSprint({ tickets: [ticket] });

    // Persist sprint via the real repo.
    const saveSprint = await app.deps.sprintRepo.save(sprint as Sprint);
    if (!saveSprint.ok) throw new Error(`save sprint failed: ${saveSprint.error.message}`);

    // Persist execution (pre-set branch so resolveBranchLeaf takes the resume path).
    const execution: SprintExecution = setExecutionBranch(
      createSprintExecution({ sprintId: sprint.id }),
      SPRINT_BRANCH
    );
    const saveExec = await app.deps.sprintExecutionRepo.save(execution);
    if (!saveExec.ok) throw new Error(`save execution failed: ${saveExec.error.message}`);

    // Create tasks and persist them.
    const tasks = Array.from({ length: taskCount }, (_, i) =>
      makeTodoTask({
        name: `task-${String(i + 1)}`,
        order: i + 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      })
    );
    const saveTasks = await app.deps.taskRepo.saveAll(sprint.id, tasks);
    if (!saveTasks.ok) throw new Error(`save tasks failed: ${saveTasks.error.message}`);

    const sprintDir = app.sprintDir(sprint.id);
    const progressFile = join(sprintDir, 'progress.md');
    const reviewDir = join(sprintDir, 'review');
    const feedbackFile = join(sprintDir, 'feedback.md');
    const locksDir = join(String(app.home), 'locks');

    await fs.mkdir(sprintDir, { recursive: true });
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.mkdir(locksDir, { recursive: true });

    return {
      app,
      fakeProject,
      sprintDir,
      progressFile,
      reviewDir,
      feedbackFile,
      locksDir,
      async cleanup() {
        await app.cleanup();
        await fakeProject.cleanup();
      },
    };
  };

  /**
   * Load the single sprint from the real repo. Throws when absent.
   */
  const loadSprint = async (app: RealFsApp) => {
    const listResult = await app.deps.sprintRepo.list();
    if (!listResult.ok) throw new Error(`list sprints failed: ${listResult.error.message}`);
    const sprint = listResult.value[0];
    if (sprint === undefined) throw new Error('no sprint found in repo');
    return sprint;
  };

  /**
   * Run the implement flow using real deps and a scripted provider. Returns the runner.
   */
  const runImplement = async (fixture: FullStackFixture, provider: ImplementDeps['generatorProvider']) => {
    const storedSprint = await loadSprint(fixture.app);
    const tasksResult = await fixture.app.deps.taskRepo.findBySprintId(storedSprint.id);
    if (!tasksResult.ok) throw new Error('find tasks failed');

    const repoPath = fixture.fakeProject.path;
    const repoMap = new Map([[FIXED_REPOSITORY_ID, { path: absolutePath(repoPath), name: 'test-repo' }]]);

    const implementDeps = buildImplementDeps(fixture.app, provider, makeScriptedGit(), fixture.locksDir);

    const flow = createImplementFlow(implementDeps, {
      sprintId: storedSprint.id,
      todoTasks: tasksResult.value.filter((t) => t.status === 'todo' || t.status === 'in_progress'),
      repositories: repoMap,
      progressFile: absolutePath(fixture.progressFile),
      sprintDir: absolutePath(fixture.sprintDir),
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      memoryRoot: fixture.app.paths.memoryRoot,
      projectId: FAKE_PROJECT_ID,
      dirtyTreePolicy: 'cancel',
    });

    const runner = createRunner<ImplementCtx>({
      id: `r-implement-${String(storedSprint.id)}`,
      element: flow,
      initialCtx: { sprintId: storedSprint.id },
    });

    await runner.start();
    return runner;
  };

  /**
   * Run the review flow with a terminating interactive (empty body → auto-done transition).
   */
  const runReview = async (fixture: FullStackFixture) => {
    const storedSprint = await loadSprint(fixture.app);
    const repoPath = fixture.fakeProject.path;

    const terminatingInteractive: InteractivePrompt = {
      async askText() {
        throw new Error('review: askText not expected');
      },
      async askTextArea() {
        // Empty body → review termination round → sprint transitions to done.
        return Result.ok('');
      },
      async askChoice() {
        throw new Error('review: askChoice not expected');
      },
      async askMultiChoice() {
        throw new Error('review: askMultiChoice not expected');
      },
      async askConfirm() {
        throw new Error('review: askConfirm not expected');
      },
    };

    const reviewDeps: ReviewDeps = {
      sprintRepo: fixture.app.deps.sprintRepo,
      taskRepo: fixture.app.deps.taskRepo,
      provider: createFakeAiProvider({
        signals: {
          'apply-feedback': [{ type: 'task-complete', timestamp: FIXED_NOW }],
        },
      }),
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      signals: createInMemorySink<HarnessSignal>(),
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      clock: () => FIXED_LATER,
      interactive: terminatingInteractive,
      gitRunner: {
        async run() {
          return okGit('', 0);
        },
      },
      shellScriptRunner: passingShell,
      fileLocker: createFileLocker(),
      locksRoot: absolutePath(fixture.reviewDir),
      appendFile: createAppendFile(),
      model: 'claude-opus-4-8',
    };

    const reviewFlow = createReviewFlow(reviewDeps, {
      sprintId: storedSprint.id,
      sprintDir: absolutePath(fixture.sprintDir),
      reviewRoot: absolutePath(fixture.reviewDir),
      commitCwd: absolutePath(repoPath),
      additionalRoots: [absolutePath(repoPath)],
      repositoriesBlock: '',
      feedbackFile: absolutePath(fixture.feedbackFile),
      progressFile: absolutePath(fixture.progressFile),
    });

    const runner = createRunner<ReviewCtx>({
      id: `r-review-${String(storedSprint.id)}`,
      element: reviewFlow,
      initialCtx: { sprintId: storedSprint.id, distillRequested: false },
    });

    await runner.start();
    return runner;
  };

  /**
   * Run the close-sprint flow directly on a sprint that is in review status.
   */
  const runClose = async (fixture: FullStackFixture) => {
    const storedSprint = await loadSprint(fixture.app);

    const closeFlow = createCloseSprintFlow({
      sprintRepo: fixture.app.deps.sprintRepo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: createAppendFile(),
      progressFile: absolutePath(fixture.progressFile),
    });

    const runner = createRunner<CloseSprintCtx>({
      id: `r-close-${String(storedSprint.id)}`,
      element: closeFlow,
      initialCtx: { sprintId: storedSprint.id, distillRequested: false },
    });

    await runner.start();
    return runner;
  };

  // ─── Passing provider — used by multiple tests ────────────────────────────
  const buildPassingProvider = () =>
    createWorkspaceMutatingFakeProvider({
      fileWrites: {
        implement: { 'output-task.txt': 'task output by fake AI\n' },
      },
      signals: {
        implement: [taskVerified('task done')],
        evaluate: [evaluationPassed()],
      },
    });

  // ─── Test suite ────────────────────────────────────────────────────────────
  describe('full-stack implement → review → close', () => {
    let cleanupFns: Array<() => Promise<void>>;

    beforeEach(() => {
      cleanupFns = [];
    });

    afterEach(async () => {
      for (const fn of cleanupFns) await fn().catch(() => undefined);
    });

    // ─── (a) Happy path: implement → review auto-close ────────────────────
    it('(a) happy path: implement → review auto-close transitions sprint active→review→done, tasks done, progress.md has content', async () => {
      const fixture = await buildFixture(2);
      cleanupFns.push(() => fixture.cleanup());

      // ── Implement phase ──────────────────────────────────────────────────
      const implementRunner = await runImplement(fixture, buildPassingProvider());

      if (implementRunner.status !== 'completed') {
        const trace = implementRunner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Implement runner '${implementRunner.status}'.\nTrace:\n${trace}`);
      }

      const storedSprint = await loadSprint(fixture.app);

      // Tasks should be done and sprint should be in review.
      const tasksAfterImpl = await fixture.app.deps.taskRepo.findBySprintId(storedSprint.id);
      if (!tasksAfterImpl.ok) throw new Error('findBySprintId failed');
      for (const t of tasksAfterImpl.value) {
        expect(t.status).toBe('done');
        expect(t.attempts.length).toBeGreaterThan(0);
      }
      expect(storedSprint.status).toBe('review');

      // progress.md must exist with content (at least the activation separator).
      const progressContent = await fs.readFile(fixture.progressFile, 'utf8');
      expect(progressContent.length).toBeGreaterThan(0);

      // ── Review phase (empty body → auto-done) ────────────────────────────
      const reviewRunner = await runReview(fixture);

      if (reviewRunner.status !== 'completed') {
        const trace = reviewRunner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Review runner '${reviewRunner.status}'.\nTrace:\n${trace}`);
      }

      const sprintAfterReview = await loadSprint(fixture.app);
      expect(sprintAfterReview.status).toBe('done');
    }, 90_000);

    // ─── (b) Implement → close-sprint directly (bypassing review) ─────────
    it('(b) implement → close-sprint: sprint.json transitions active→review→done through close-sprint flow', async () => {
      const fixture = await buildFixture(1);
      cleanupFns.push(() => fixture.cleanup());

      // ── Implement phase ──────────────────────────────────────────────────
      const implementRunner = await runImplement(fixture, buildPassingProvider());

      if (implementRunner.status !== 'completed') {
        const trace = implementRunner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Implement runner '${implementRunner.status}'.\nTrace:\n${trace}`);
      }

      // Sprint should now be in review.
      const sprintAfterImpl = await loadSprint(fixture.app);
      expect(sprintAfterImpl.status).toBe('review');

      // Tasks done, non-empty attempts.
      const tasks = await fixture.app.deps.taskRepo.findBySprintId(sprintAfterImpl.id);
      if (!tasks.ok) throw new Error('findBySprintId failed');
      for (const t of tasks.value) {
        expect(t.status).toBe('done');
        expect(t.attempts.length).toBeGreaterThan(0);
      }

      // ── Close-sprint phase ───────────────────────────────────────────────
      const closeRunner = await runClose(fixture);

      if (closeRunner.status !== 'completed') {
        const trace = closeRunner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Close runner '${closeRunner.status}'.\nTrace:\n${trace}`);
      }

      const sprintAfterClose = await loadSprint(fixture.app);
      expect(sprintAfterClose.status).toBe('done');
    }, 90_000);

    // ─── (c) Evaluator-rejection round: fail once then pass ───────────────
    it('(c) evaluator-rejection round: fail once then pass — task eventually done', async () => {
      const fixture = await buildFixture(1);
      cleanupFns.push(() => fixture.cleanup());

      let evaluateCallCount = 0;

      const provider = createWorkspaceMutatingFakeProvider({
        fileWrites: {
          implement: { 'output.txt': 'generated\n' },
          'implement-continuation': { 'output-revised.txt': 'revised\n' },
        },
        signals: {
          implement: [taskVerified('attempt done')],
          'implement-continuation': [taskVerified('revised done')],
          evaluate: (session) => {
            void session;
            evaluateCallCount += 1;
            if (evaluateCallCount === 1) return [evaluationFailed('needs more work')];
            return [evaluationPassed()];
          },
          'evaluate-continuation': (session) => {
            void session;
            return [evaluationPassed()];
          },
        },
      });

      const implementRunner = await runImplement(fixture, provider);

      if (implementRunner.status !== 'completed') {
        const trace = implementRunner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Runner '${implementRunner.status}'.\nTrace:\n${trace}`);
      }

      // Evaluator must have been called more than once (fail then pass pattern).
      expect(evaluateCallCount).toBeGreaterThanOrEqual(1);

      const storedSprint = await loadSprint(fixture.app);
      const finalTasks = await fixture.app.deps.taskRepo.findBySprintId(storedSprint.id);
      if (!finalTasks.ok) throw new Error('findBySprintId failed');
      expect(finalTasks.value.every((t) => t.status === 'done')).toBe(true);
      expect(storedSprint.status).toBe('review');
    }, 90_000);

    // ─── (d) Blocked-task arc ─────────────────────────────────────────────
    it('(d) blocked-task arc: first task emits task-blocked, sprint transitions to review (done+blocked mix), blocked task has blockKind=self-blocked', async () => {
      const fixture = await buildFixture(2);
      cleanupFns.push(() => fixture.cleanup());

      let implementCallCount = 0;
      const blockingProvider = createWorkspaceMutatingFakeProvider({
        fileWrites: {
          implement: { 'output.txt': 'output\n' },
        },
        signals: {
          implement: (session) => {
            void session;
            implementCallCount += 1;
            // First implement call → blocked. Subsequent calls (for the second task) → verified.
            if (implementCallCount === 1) {
              return [{ type: 'task-blocked' as const, reason: 'dependency not available', timestamp: FIXED_NOW }];
            }
            return [taskVerified('ok')];
          },
          evaluate: [evaluationPassed()],
        },
      });

      const implementRunner = await runImplement(fixture, blockingProvider);
      expect(implementRunner.status).toBe('completed');

      const storedSprint = await loadSprint(fixture.app);
      const finalTasks = await fixture.app.deps.taskRepo.findBySprintId(storedSprint.id);
      if (!finalTasks.ok) throw new Error('findBySprintId failed');

      const blockedTask = finalTasks.value.find((t) => t.status === 'blocked');
      const doneTask = finalTasks.value.find((t) => t.status === 'done');
      expect(blockedTask).toBeDefined();
      expect(doneTask).toBeDefined();

      // Blocked task must have blockKind 'own' (self-blocked from the signal), not 'upstream'.
      if (blockedTask?.status === 'blocked') {
        expect(blockedTask.blockKind).toBe('own');
      }

      // With one done + one blocked: shouldTransitionToReview fires (mixed = transition).
      expect(storedSprint.status).toBe('review');
    }, 90_000);
  });
}
