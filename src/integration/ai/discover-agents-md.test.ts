import { describe, expect, it, vi } from 'vitest';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { discoverAgentsMdWithAi, DISCOVERY_TIMEOUT_MS } from './discover-agents-md.ts';
import type { RepoOnboardPromptContext } from '@src/integration/ai/prompts/loader.ts';

function makeAiSession(spawnHeadless: AiSessionPort['spawnHeadless']): AiSessionPort {
  return {
    spawnInteractive: vi.fn(),
    spawnHeadless,
    spawnWithRetry: vi.fn(),
    resumeSession: vi.fn(),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getProviderName: vi.fn(() => 'claude' as const),
    getProviderDisplayName: vi.fn(() => 'Claude'),
    getSpawnEnv: vi.fn(() => ({})),
  };
}

function baseCtx(): RepoOnboardPromptContext {
  return {
    repoPath: '/fake/repo',
    mode: 'bootstrap',
    existingAgentsMd: null,
    projectType: 'node',
    checkScriptSuggestion: '',
    fileName: 'CLAUDE.md',
  };
}

describe('discoverAgentsMdWithAi', () => {
  const parser = new SignalParser();

  it('returns both project context file and check script when provider emits both signals', async () => {
    const output = [
      '<agents-md># Demo\n\n## Build\n\npnpm install</agents-md>',
      '<check-script>pnpm test</check-script>',
    ].join('\n');
    const session = makeAiSession(() => Promise.resolve({ output }));
    const result = await discoverAgentsMdWithAi(baseCtx(), session, parser);
    expect(result.agentsMd).toBe('# Demo\n\n## Build\n\npnpm install');
    expect(result.checkScript).toBe('pnpm test');
    expect(result.changes).toBeNull();
  });

  it('captures a <changes> block alongside signals', async () => {
    const output = [
      '<agents-md>body</agents-md>',
      '<check-script>make ci</check-script>',
      '<changes>\n- added build command\n- removed stale lint\n</changes>',
    ].join('\n');
    const session = makeAiSession(() => Promise.resolve({ output }));
    const result = await discoverAgentsMdWithAi(baseCtx(), session, parser);
    expect(result.changes).toBe('- added build command\n- removed stale lint');
  });

  it('returns all nulls when output has no signal tags', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: 'I have nothing to add.' }));
    const result = await discoverAgentsMdWithAi(baseCtx(), session, parser);
    expect(result).toEqual({ agentsMd: null, checkScript: null, changes: null });
  });

  it('returns all nulls when the spawn never resolves (timeout path)', async () => {
    vi.useFakeTimers();
    try {
      // Spawn promise that never resolves — the timeout inside the function
      // should race it and return nulls.
      const session = makeAiSession(() => new Promise<never>(() => undefined));
      const promise = discoverAgentsMdWithAi(baseCtx(), session, parser);
      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS + 10);
      const result = await promise;
      expect(result).toEqual({ agentsMd: null, checkScript: null, changes: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns all nulls when the provider throws', async () => {
    const session = makeAiSession(() => Promise.reject(new Error('boom')));
    const result = await discoverAgentsMdWithAi(baseCtx(), session, parser);
    expect(result).toEqual({ agentsMd: null, checkScript: null, changes: null });
  });

  it('returns agentsMd only when check-script is absent', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: '<agents-md>just the body</agents-md>' }));
    const result = await discoverAgentsMdWithAi(baseCtx(), session, parser);
    expect(result.agentsMd).toBe('just the body');
    expect(result.checkScript).toBeNull();
  });
});
