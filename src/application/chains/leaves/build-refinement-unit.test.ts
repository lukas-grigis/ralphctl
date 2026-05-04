import { describe, expect, it } from 'vitest';

import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { makeSprint, makeTicket } from '@src/application/_test-fakes/fixtures.ts';
import { buildRefinementUnitLeaf, type BuildRefinementUnitCtx } from './build-refinement-unit.ts';

const STORAGE_ERROR = new StorageError({ subCode: 'io', message: 'disk full' });

describe('buildRefinementUnitLeaf', () => {
  describe('happy path', () => {
    it('calls buildRefinementUnit with sprint, ticket and aiProvider from context', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTicket = makeTicket({ title: 'My ticket' });

      const result = await leaf.execute({ sprint, currentTicket });

      expect(result.ok).toBe(true);
      expect(sessionFolderBuilder.refinementCalls).toHaveLength(1);

      const call = sessionFolderBuilder.refinementCalls[0];
      expect(call?.sprint).toBe(sprint);
      expect(call?.ticket).toBe(currentTicket);
      expect(call?.aiProvider).toBe('claude');
    });

    it('stamps cwd, refinementUnitRoot, refinementSessionMdPath, refinementTicketMdPath and refinementRequirementsJsonPath onto ctx', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ rootPrefix: '/fake-refine' });
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTicket = makeTicket({ title: 'Auth ticket' });

      const result = await leaf.execute({ sprint, currentTicket });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ctx = result.value.ctx;
      // cwd and refinementUnitRoot both receive the same root path
      expect(String(ctx.cwd)).toContain('refinement');
      expect(String(ctx.refinementUnitRoot)).toBe(String(ctx.cwd));
      // each sub-path should contain its filename
      expect(String(ctx.refinementSessionMdPath)).toContain('session.md');
      expect(String(ctx.refinementTicketMdPath)).toContain('ticket.md');
      expect(String(ctx.refinementRequirementsJsonPath)).toContain('requirements.json');
    });

    it('uses the ticket title to derive the unit slug (path contains a sanitised version)', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ rootPrefix: '/fake-refine' });
      const aiSession = new FakeAiSessionPort({ providerName: 'claude' });
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTicket = makeTicket({ title: 'User Login Flow' });

      const result = await leaf.execute({ sprint, currentTicket });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The fake derives the slug from ticket title — "user-login-flow" should appear in the path.
      expect(String(result.value.ctx.refinementUnitRoot)).toContain('user-login-flow');
    });

    it('preserves extra ctx fields on output', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx & { extra: string }>({
        sessionFolderBuilder,
        aiSession,
      });

      const sprint = makeSprint();
      const currentTicket = makeTicket();

      const result = await leaf.execute({ sprint, currentTicket, extra: 'passthrough' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value.ctx as { extra: string }).extra).toBe('passthrough');
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

      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });
      const sprint = makeSprint();
      const currentTicket = makeTicket();

      await leaf.execute({ sprint, currentTicket });

      expect(ensureReadyCalled).toBe(true);
    });

    it('records step name and completed status in the trace', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTicket = makeTicket();

      const result = await leaf.execute({ sprint, currentTicket });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.stepName).toBe('build-refinement-unit');
      expect(result.value.trace[0]?.status).toBe('completed');
    });

    it('respects the custom opts.name when provided', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort();
      const aiSession = new FakeAiSessionPort();
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>(
        { sessionFolderBuilder, aiSession },
        { name: 'custom-refinement-unit' }
      );

      const sprint = makeSprint();
      const currentTicket = makeTicket();
      const result = await leaf.execute({ sprint, currentTicket });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.trace[0]?.stepName).toBe('custom-refinement-unit');
    });
  });

  describe('error path', () => {
    it('surfaces the error verbatim when buildRefinementUnit fails', async () => {
      const sessionFolderBuilder = new FakeSessionFolderBuilderPort({ failWith: STORAGE_ERROR });
      const aiSession = new FakeAiSessionPort();
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({ sessionFolderBuilder, aiSession });

      const sprint = makeSprint();
      const currentTicket = makeTicket();

      const result = await leaf.execute({ sprint, currentTicket });

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
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const currentTicket = makeTicket();
      const result = await leaf.execute({ currentTicket });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.sprint must be loaded/);
    });

    it('fails the step when ctx.currentTicket is missing', async () => {
      const leaf = buildRefinementUnitLeaf<BuildRefinementUnitCtx>({
        sessionFolderBuilder: new FakeSessionFolderBuilderPort(),
        aiSession: new FakeAiSessionPort(),
      });
      const sprint = makeSprint();
      const result = await leaf.execute({ sprint });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toMatch(/ctx.currentTicket must be set/);
    });
  });
});
