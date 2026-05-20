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
  provider: 'claude-code',
  models: {
    refine: 'claude-sonnet-4-6',
    plan: 'claude-opus-4-7',
    implement: 'claude-opus-4-7',
    readiness: 'claude-sonnet-4-6',
    ideate: 'claude-sonnet-4-6',
  },
};

const copilotConfig: Settings['ai'] = {
  provider: 'github-copilot',
  models: {
    refine: 'gpt-5-mini',
    plan: 'gpt-5.4',
    implement: 'gpt-5.4',
    readiness: 'gpt-5-mini',
    ideate: 'gpt-5-mini',
  },
};

const codexConfig: Settings['ai'] = {
  provider: 'openai-codex',
  models: {
    refine: 'gpt-5.3-codex',
    plan: 'gpt-5.4',
    implement: 'gpt-5.3-codex',
    readiness: 'gpt-5.4-mini',
    ideate: 'gpt-5.4-mini',
  },
};

describe('createAiProvider', () => {
  it('dispatches to the Claude adapter when ai.provider is `claude-code`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ ai: claudeConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('dispatches to the Copilot adapter when ai.provider is `github-copilot`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ ai: copilotConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('dispatches to the Codex adapter when ai.provider is `openai-codex`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ ai: codexConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });
});
