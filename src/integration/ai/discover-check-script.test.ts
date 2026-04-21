import { describe, expect, it, vi } from 'vitest';
import { SpawnError } from '@src/domain/errors.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import { SignalParser } from '@src/integration/signals/parser.ts';
import { discoverCheckScriptWithAi } from './discover-check-script.ts';

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

describe('discoverCheckScriptWithAi', () => {
  const parser = new SignalParser();

  it('returns the parsed script when the provider emits a check-script-discovery signal', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: '<check-script>make check</check-script>' }));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBe('make check');
  });

  it('trims surrounding whitespace and newlines from the tagged command', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: '<check-script>\n  pnpm test  \n</check-script>' }));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBe('pnpm test');
  });

  it('returns null when the provider returns an empty tag', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: '<check-script></check-script>' }));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBeNull();
  });

  it('returns null when the provider response is unparseable', async () => {
    const session = makeAiSession(() => Promise.resolve({ output: 'I do not know' }));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBeNull();
  });

  it('returns null when the provider throws a SpawnError', async () => {
    const session = makeAiSession(() => Promise.reject(new SpawnError('rate limited', '429', 1)));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBeNull();
  });

  it('returns null when the provider throws an arbitrary error', async () => {
    const session = makeAiSession(() => Promise.reject(new Error('unexpected')));
    const result = await discoverCheckScriptWithAi('/fake/repo', session, parser);
    expect(result).toBeNull();
  });
});
