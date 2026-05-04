import { describe, expect, it } from 'vitest';

import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { makeSprint } from '@src/application/_test-fakes/fixtures.ts';
import { buildPlanningFolderLeaf, type BuildPlanningFolderCtx } from './build-planning-folder.ts';

const STORAGE_ERROR = new StorageError({ subCode: 'io', message: 'disk full' });

describe('buildPlanningFolderLeaf', () => {
  describe('happy path', () => {
    it('calls buildPlanningFolder with sprint and aiProvider from context', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      expect(sessionFolderBuilder.planningCalls).toHaveLength(1);

      const call = sessionFolderBuilder.planningCalls[0];
      expect(call?.sprint).toBe(sprint);
      expect(call?.aiProvider).toBe('claude');
    });

    it('stamps cwd, planningFolderRoot, planningSessionMdPath, planningRawTasksJsonPath and planAddDirs onto ctx', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ rootPrefix: '/fake-planning' });
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ctx = result.value.ctx;
      // cwd and planningFolderRoot both receive the root path
      expect(String(ctx.cwd)).toContain('planning');
      expect(String(ctx.planningFolderRoot)).toBe(String(ctx.cwd));
      // session.md and tasks.json paths are sub-paths of the root
      expect(String(ctx.planningSessionMdPath)).toContain('session.md');
      expect(String(ctx.planningRawTasksJsonPath)).toContain('tasks.json');
      expect(ctx.planAddDirs).toBeDefined();
    });

    it('propagates affectedRepositories as addDirs for the claude provider', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The fake returns sprint.affectedRepositories as addDirs for claude.
      // Sprint has no affected repos by default, so the list is empty but defined.
      expect(Array.isArray(result.value.ctx.planAddDirs)).toBe(true);
    });

    it('returns empty addDirs for the copilot provider', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'copilot' });
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The fake returns [] for copilot (no --add-dir equivalent).
      expect(result.value.ctx.planAddDirs).toStrictEqual([]);
    });

    it('preserves extra ctx fields on output', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx & { extra: string }>({
        sessionFolderBuilder,
        aiSession,
      });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint, extra: 'passthrough' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value.ctx as { extra: string }).extra).toBe('passthrough');
    });

    it('calls ensureReady on aiSession before building the folder', async () => {
      let ensureReadyCalled = false;
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const originalEnsureReady = aiSession.ensureReady.bind(aiSession);
      aiSession.ensureReady = async () => {
        ensureReadyCalled = true;
        return originalEnsureReady();
      };

      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });
      const sprint = makeSprint();
      await leaf.execute({ sprint });

      expect(ensureReadyCalled).toBe(true);
    });

    it('records step name and completed status in the trace', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.stepName).toBe('build-planning-folder');
      expect(result.value.trace[0]?.status).toBe('completed');
    });

    it('respects the custom opts.name when provided', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>(
        { sessionFolderBuilder, aiSession },
        { name: 'custom-planning-folder' }
      );

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace[0]?.stepName).toBe('custom-planning-folder');
    });
  });

  describe('error path', () => {
    it('surfaces the error verbatim when buildPlanningFolder fails', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ failWith: STORAGE_ERROR });
      const aiSession = new FakeAiSessionPort();
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });

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
      const leaf = buildPlanningFolderLeaf<BuildPlanningFolderCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const result = await leaf.execute({});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.sprint must be loaded/);
    });
  });
});
