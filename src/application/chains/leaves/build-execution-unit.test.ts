import { describe, expect, it } from 'vitest';

import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { buildExecutionUnitLeaf, type BuildExecutionUnitCtx } from './build-execution-unit.ts';

const STORAGE_ERROR = new StorageError({ subCode: 'io', message: 'disk full' });

describe('buildExecutionUnitLeaf', () => {
  describe('happy path', () => {
    it('calls buildExecutionUnit with sprint, tasks, task, aiProvider and priorEvaluations from context', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const task = makeTask({ name: 'first task' });
      const tasks = [task];

      const result = await leaf.execute({ sprint, tasks, task });

      expect(result.ok).toBe(true);
      expect(sessionFolderBuilder.executionCalls).toHaveLength(1);

      const call = sessionFolderBuilder.executionCalls[0];
      expect(call?.sprint).toBe(sprint);
      expect(call?.tasks).toBe(tasks);
      expect(call?.task).toBe(task);
      expect(call?.aiProvider).toBe('claude');
      // No task has evaluation output → empty map
      expect(call?.priorEvaluations.size).toBe(0);
    });

    it('stamps the returned paths onto ctx as executionUnitRoot / executionAddDirs / executionSessionCwd', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ rootPrefix: '/fake-units' });
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const task = makeTask({ name: 'second task' });

      const result = await leaf.execute({ sprint, tasks: [task], task });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ctx = result.value.ctx;
      expect(ctx.executionUnitRoot).toBeDefined();
      expect(ctx.executionAddDirs).toBeDefined();
      expect(ctx.executionSessionCwd).toBeDefined();
    });

    it('preserves extra ctx fields on output', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx & { extra: string }>({
        sessionFolderBuilder,
        aiSession,
      });

      const sprint = makeSprint();
      const task = makeTask();

      const result = await leaf.execute({ sprint, tasks: [task], task, extra: 'passthrough' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value.ctx as { extra: string }).extra).toBe('passthrough');
    });

    it('includes prior evaluations for tasks that have been evaluated with non-empty output', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'copilot' });
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTask = makeTask({ name: 'current' });
      const evaluatedTask = makeTask({ name: 'prior' }).recordEvaluation({
        output: 'looks good',
        status: 'passed',
        file: '',
      });
      const tasks = [evaluatedTask, currentTask];

      const result = await leaf.execute({ sprint, tasks, task: currentTask });

      expect(result.ok).toBe(true);
      const call = sessionFolderBuilder.executionCalls[0];
      expect(call?.priorEvaluations.size).toBe(1);
      expect(call?.priorEvaluations.get(evaluatedTask.id)).toBe('looks good');
    });

    it('excludes tasks with empty evaluation output from priorEvaluations', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const evaluatedEmpty = makeTask({ name: 'empty-eval' }).recordEvaluation({
        output: '',
        status: 'passed',
        file: '',
      });
      const currentTask = makeTask({ name: 'current' });

      const result = await leaf.execute({ sprint, tasks: [evaluatedEmpty, currentTask], task: currentTask });

      expect(result.ok).toBe(true);
      const call = sessionFolderBuilder.executionCalls[0];
      expect(call?.priorEvaluations.size).toBe(0);
    });

    it('calls ensureReady on aiSession before building the unit', async () => {
      let ensureReadyCalled = false;
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const originalEnsureReady = aiSession.ensureReady.bind(aiSession);
      aiSession.ensureReady = async () => {
        ensureReadyCalled = true;
        return originalEnsureReady();
      };

      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });
      const sprint = makeSprint();
      const task = makeTask();

      await leaf.execute({ sprint, tasks: [task], task });

      expect(ensureReadyCalled).toBe(true);
    });

    it('records step name and completed status in the trace', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const task = makeTask();

      const result = await leaf.execute({ sprint, tasks: [task], task });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.stepName).toBe('build-execution-unit');
      expect(result.value.trace[0]?.status).toBe('completed');
    });

    it('respects the custom opts.name when provided', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>(
        { sessionFolderBuilder, aiSession },
        { name: 'custom-execution-unit' }
      );

      const sprint = makeSprint();
      const task = makeTask();
      const result = await leaf.execute({ sprint, tasks: [task], task });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace[0]?.stepName).toBe('custom-execution-unit');
    });
  });

  describe('error path', () => {
    it('surfaces the error verbatim when buildExecutionUnit fails', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ failWith: STORAGE_ERROR });
      const aiSession = new FakeAiSessionPort();
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const task = makeTask();

      const result = await leaf.execute({ sprint, tasks: [task], task });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.error).toBe(STORAGE_ERROR);
      expect(result.error.trace[0]?.status).toBe('failed');
    });
  });

  describe('missing ctx guard', () => {
    // Note: the Leaf framework catches throws from the input() function and
    // wraps them in Result.error — the promise resolves, it does not reject.
    it('fails the step when ctx.sprint is missing', async () => {
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const task = makeTask();
      const result = await leaf.execute({ tasks: [task], task });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.sprint must be loaded/);
    });

    it('fails the step when ctx.tasks is missing', async () => {
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const sprint = makeSprint();
      const task = makeTask();
      const result = await leaf.execute({ sprint, task });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.tasks must be set/);
    });

    it('fails the step when ctx.task is missing', async () => {
      const leaf = buildExecutionUnitLeaf<BuildExecutionUnitCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const sprint = makeSprint();
      const task = makeTask();
      const result = await leaf.execute({ sprint, tasks: [task] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.task must be set/);
    });
  });
});
