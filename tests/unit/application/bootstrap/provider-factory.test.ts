import { describe, expect, it } from 'vitest';
import type { Settings } from '@src/domain/entity/settings.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredChild } from '@src/integration/ai/providers/_engine/child-registry.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { makeProviderSpawn } from '@tests/fixtures/provider-spawn-fake.ts';

const harnessConfig: Settings['harness'] = {
  maxTurns: 5,
  maxAttempts: 3,
  rateLimitRetries: 2,
  idleWatchdogMs: 300_000,
  plateauThreshold: 2,
  correctiveRetries: 2,
  escalateOnPlateau: false,
  escalationMap: {},
  skipPreVerifyOnFreshSetup: false,
};

const claudeConfig: Settings['ai'] = {
  refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8' },
  },
  readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
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
  createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
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
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

const opencodeConfig: Settings['ai'] = {
  refine: { provider: 'opencode', model: 'opencode/north-mini-code-free' },
  plan: { provider: 'opencode', model: 'opencode/big-pickle' },
  implement: {
    generator: { provider: 'opencode', model: 'opencode/big-pickle' },
    evaluator: { provider: 'opencode', model: 'opencode/big-pickle' },
  },
  readiness: { provider: 'opencode', model: 'opencode/north-mini-code-free' },
  ideate: { provider: 'opencode', model: 'opencode/big-pickle' },
  createPr: { provider: 'opencode', model: 'opencode/north-mini-code-free' },
};

const grokConfig: Settings['ai'] = {
  refine: { provider: 'xai-grok', model: 'grok-4.5' },
  plan: { provider: 'xai-grok', model: 'grok-4.6' },
  implement: {
    generator: { provider: 'xai-grok', model: 'grok-4.6' },
    evaluator: { provider: 'xai-grok', model: 'grok-4.6' },
  },
  readiness: { provider: 'xai-grok', model: 'grok-4.5' },
  ideate: { provider: 'xai-grok', model: 'grok-4.6' },
  createPr: { provider: 'xai-grok', model: 'grok-4.5' },
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

  it('dispatches to the OpenCode adapter when the flow row uses `opencode`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ flow: 'implement', ai: opencodeConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('dispatches to the Grok adapter when the flow row uses `xai-grok`', () => {
    const eventBus = createInMemoryEventBus();
    const provider = createAiProvider({ flow: 'implement', ai: grokConfig, harnessConfig, eventBus });
    expect(typeof provider.generate).toBe('function');
  });

  it('picks the dispatched flow row when rows use different providers', () => {
    const mixed: Settings['ai'] = {
      refine: { provider: 'github-copilot', model: 'gpt-5-mini' },
      plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
      implement: {
        generator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
        evaluator: { provider: 'openai-codex', model: 'gpt-5.3-codex' },
      },
      readiness: { provider: 'github-copilot', model: 'gpt-5-mini' },
      ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
      createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
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

describe('createAiProvider — child registry wiring', () => {
  it('announces every spawned child to the injected registry and releases it on exit', async () => {
    const fake = makeProviderSpawn([{}]);
    const registered: RegisteredChild[] = [];
    let released = 0;
    const provider = createAiProvider({
      flow: 'implement',
      ai: claudeConfig,
      harnessConfig,
      eventBus: createInMemoryEventBus(),
      spawn: (command, args, options) => Object.assign(fake.spawn(command, args, options), { pid: 777 }),
      childRegistry: {
        register: (child) => {
          registered.push(child);
          return { noteSessionId: () => {}, release: () => (released += 1) };
        },
      },
    });

    await provider.generate({
      prompt: 'p' as Prompt,
      cwd: absolutePath('/repo'),
      model: 'claude-opus-4-8',
      permissions: READ_ONLY,
      signalsFile: absolutePath(join(tmpdir(), `ralphctl-pf-${String(process.pid)}`, 'signals.json')),
      role: 'evaluator',
    });

    expect(registered).toEqual([
      expect.objectContaining({ pid: 777, provider: 'claude-code', cwd: '/repo', role: 'evaluator' }),
    ]);
    expect(registered[0]?.pgid).toBeUndefined();
    expect(released).toBe(1);
  });
});
