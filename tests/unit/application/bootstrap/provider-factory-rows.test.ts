import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiFlowSettings, Settings } from '@src/domain/entity/settings.ts';

/**
 * Spy-driven coverage for the explicit `{ row }` shape of {@link createAiProvider}. The two
 * implement-role launchers (generator + evaluator) call the factory once each with
 * `ai.implement.generator` and `ai.implement.evaluator`; this suite asserts the per-provider
 * factory call counts so a future refactor can't silently collapse the two roles back into a
 * single provider.
 */

vi.mock('@src/integration/ai/providers/claude/headless.ts', () => ({
  createClaudeProvider: vi.fn(() => ({ generate: vi.fn(), name: 'claude' })),
}));
vi.mock('@src/integration/ai/providers/copilot/headless.ts', () => ({
  createCopilotProvider: vi.fn(() => ({ generate: vi.fn(), name: 'copilot' })),
}));
vi.mock('@src/integration/ai/providers/codex/headless.ts', () => ({
  createCodexProvider: vi.fn(() => ({ generate: vi.fn(), name: 'codex' })),
}));

import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

const harnessConfig: Settings['harness'] = {
  maxTurns: 5,
  maxAttempts: 3,
  rateLimitRetries: 2,
  plateauThreshold: 2,
  escalateOnPlateau: false,
  escalationMap: {},
};

const claudeRow: AiFlowSettings = { provider: 'claude-code', model: 'claude-opus-4-7' };
const codexRow: AiFlowSettings = { provider: 'openai-codex', model: 'gpt-5.5' };
const copilotRow: AiFlowSettings = { provider: 'github-copilot', model: 'gpt-5.4' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('createAiProvider — explicit row', () => {
  it('dispatches to the Claude adapter when row.provider is claude-code', () => {
    const eventBus = createInMemoryEventBus();
    createAiProvider({ row: claudeRow, harnessConfig, eventBus });
    expect(createClaudeProvider).toHaveBeenCalledTimes(1);
    expect(createCopilotProvider).not.toHaveBeenCalled();
    expect(createCodexProvider).not.toHaveBeenCalled();
  });

  it('dispatches to the Codex adapter when row.provider is openai-codex', () => {
    const eventBus = createInMemoryEventBus();
    createAiProvider({ row: codexRow, harnessConfig, eventBus });
    expect(createCodexProvider).toHaveBeenCalledTimes(1);
    expect(createClaudeProvider).not.toHaveBeenCalled();
    expect(createCopilotProvider).not.toHaveBeenCalled();
  });

  it('dispatches to the Copilot adapter when row.provider is github-copilot', () => {
    const eventBus = createInMemoryEventBus();
    createAiProvider({ row: copilotRow, harnessConfig, eventBus });
    expect(createCopilotProvider).toHaveBeenCalledTimes(1);
    expect(createClaudeProvider).not.toHaveBeenCalled();
    expect(createCodexProvider).not.toHaveBeenCalled();
  });

  it('two role-specific calls produce two distinct provider spawns (generator=claude, evaluator=codex)', () => {
    // Mirrors the implement launcher's per-role construction. The factory is invoked once
    // per row, so cross-provider configurations spawn one provider per role.
    const eventBus = createInMemoryEventBus();
    createAiProvider({ row: claudeRow, harnessConfig, eventBus });
    createAiProvider({ row: codexRow, harnessConfig, eventBus });
    expect(createClaudeProvider).toHaveBeenCalledTimes(1);
    expect(createCodexProvider).toHaveBeenCalledTimes(1);
    expect(createCopilotProvider).not.toHaveBeenCalled();
  });

  it('identical rows still produce two factory calls — caller decides whether to share the instance', () => {
    // Behaviour parity with the cross-provider case: the factory does not cache. Two
    // identical-row calls = two adapter constructions. The implement launcher accepts this
    // (per-spawn rebuild cost is negligible) so the deps shape stays one-provider-per-role.
    const eventBus = createInMemoryEventBus();
    createAiProvider({ row: claudeRow, harnessConfig, eventBus });
    createAiProvider({ row: claudeRow, harnessConfig, eventBus });
    expect(createClaudeProvider).toHaveBeenCalledTimes(2);
  });
});
