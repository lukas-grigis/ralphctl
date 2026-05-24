import { describe, expect, it } from 'vitest';
import type { Settings } from '@src/domain/entity/settings.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

const harnessConfig: Settings['harness'] = {
  maxTurns: 5,
  maxAttempts: 3,
  rateLimitRetries: 2,
  plateauThreshold: 2,
};

const claudeConfig: Settings['ai'] = {
  refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-7' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-7' },
  },
  readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
};

const copilotConfig: Settings['ai'] = {
  refine: { provider: 'github-copilot', model: 'gpt-5-mini' },
  plan: { provider: 'github-copilot', model: 'gpt-5.4' },
  implement: {
    generator: { provider: 'github-copilot', model: 'gpt-5.4' },
    evaluator: { provider: 'github-copilot', model: 'gpt-5.4' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini' },
  ideate: { provider: 'github-copilot', model: 'gpt-5-mini' },
};

const codexConfig: Settings['ai'] = {
  refine: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
  plan: { provider: 'openai-codex', model: 'gpt-5.4' },
  implement: {
    generator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

describe('createAiProvider', () => {
  it('dispatches to the Claude adapter when the flow row uses `claude-code`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ flow: 'implement', ai: claudeConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('dispatches to the Copilot adapter when the flow row uses `github-copilot`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ flow: 'implement', ai: copilotConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('dispatches to the Codex adapter when the flow row uses `openai-codex`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ flow: 'implement', ai: codexConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('picks the dispatched flow row when rows use different providers', () => {
    const mixed: Settings['ai'] = {
      refine: { provider: 'github-copilot', model: 'gpt-5-mini' },
      plan: { provider: 'claude-code', model: 'claude-opus-4-7' },
      implement: {
        generator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        evaluator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
      },
      readiness: { provider: 'github-copilot', model: 'gpt-5-mini' },
      ideate: { provider: 'claude-code', model: 'claude-opus-4-7' },
    };
    const eventBus = createInMemoryEventBus();
    const refineProvider = createAiProvider({ flow: 'refine', ai: mixed, harnessConfig, eventBus });
    const planProvider = createAiProvider({ flow: 'plan', ai: mixed, harnessConfig, eventBus });
    const implementProvider = createAiProvider({ flow: 'implement', ai: mixed, harnessConfig, eventBus });
    expect(typeof refineProvider.generate).toBe('function');
    expect(typeof planProvider.generate).toBe('function');
    expect(typeof implementProvider.generate).toBe('function');
  });
});
