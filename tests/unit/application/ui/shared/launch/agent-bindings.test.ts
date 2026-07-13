/**
 * `resolveRoleAgentBinding` / `buildAgentDefinitionSection` / `resolveImplementAgentBindings` —
 * the per-role opt-in agent-definition binding resolution the implement launcher composes into
 * the deps/opts bags. A missing bound name must be reported and the role must run unaided (AC2);
 * an evaluator-only binding must leave the generator role's resolution untouched (AC3).
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import type { AiImplementSettings } from '@src/domain/entity/settings.ts';
import {
  buildAgentDefinitionSection,
  resolveImplementAgentBindings,
  resolveRoleAgentBinding,
} from '@src/application/ui/shared/launch/implement-agent-bindings.ts';
import type { LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

interface RecordingLogger extends Logger {
  readonly warnings: Array<{ readonly message: string; readonly meta?: unknown }>;
}

const recordingLogger = (): RecordingLogger => {
  const warnings: Array<{ readonly message: string; readonly meta?: unknown }> = [];
  const self: RecordingLogger = {
    warnings,
    debug() {},
    info() {},
    warn(message: string, meta?: unknown) {
      warnings.push({ message, meta });
    },
    error() {},
    named: () => self,
  };
  return self;
};

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'ralphctl-evaluator',
  description: 'Reviews the generator turn.',
  content: 'You are an evaluator.\n',
  ...overrides,
});

const sourceReturning = (found: AgentDefinition | undefined): AgentDefinitionSource => ({
  list: async () => Result.ok(found !== undefined ? [found] : []),
  getByName: async () => Result.ok(found),
});

const erroringSource: AgentDefinitionSource = {
  list: async () => Result.error(new StorageError({ subCode: 'io', message: 'boom', path: '/x' })),
  getByName: async () => Result.error(new StorageError({ subCode: 'io', message: 'boom', path: '/x' })),
};

describe('resolveRoleAgentBinding', () => {
  it('returns undefined when the role has no binding at all', async () => {
    const logger = recordingLogger();
    const result = await resolveRoleAgentBinding(sourceReturning(definition()), undefined, 'generator', logger);
    expect(result).toBeUndefined();
    expect(logger.warnings).toHaveLength(0);
  });

  it('resolves the bound name against the source when found', async () => {
    const logger = recordingLogger();
    const found = definition();
    const result = await resolveRoleAgentBinding(sourceReturning(found), 'ralphctl-evaluator', 'evaluator', logger);
    expect(result).toBe(found);
    expect(logger.warnings).toHaveLength(0);
  });

  it('reports a missing bound name and continues under base behaviour (AC2)', async () => {
    const logger = recordingLogger();
    const result = await resolveRoleAgentBinding(sourceReturning(undefined), 'ralphctl-nope', 'generator', logger);
    expect(result).toBeUndefined();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toContain('ralphctl-nope');
    expect(logger.warnings[0]?.message).toContain('not found');
  });

  it('reports a source lookup failure and continues under base behaviour', async () => {
    const logger = recordingLogger();
    const result = await resolveRoleAgentBinding(erroringSource, 'ralphctl-evaluator', 'generator', logger);
    expect(result).toBeUndefined();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toContain('lookup failed');
  });
});

describe('buildAgentDefinitionSection', () => {
  it('announces the bound definition name and the adapter convention', () => {
    const adapter: AgentDefinitionAdapter = {
      install: async () => Result.ok(undefined),
      uninstall: async () => Result.ok(undefined),
      describeConvention: () => 'Files live under .claude/agents/.',
    };
    const section = buildAgentDefinitionSection(definition(), adapter);
    expect(section).toContain('ralphctl-evaluator');
    expect(section).toContain('.claude/agents/');
  });
});

describe('resolveImplementAgentBindings', () => {
  const implementPair = (agents?: AiImplementSettings['agents']): AiImplementSettings =>
    ({
      generator: { provider: 'claude-code', model: 'claude-sonnet-5' },
      evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
      ...(agents !== undefined ? { agents } : {}),
    }) as AiImplementSettings;

  const launcherDeps = (agentDefinitionSource: AgentDefinitionSource, logger: Logger): LauncherDeps =>
    ({
      app: { agentDefinitionSource, logger, eventBus: createInMemoryEventBus() },
    }) as unknown as LauncherDeps;

  it('both roles unbound resolve to empty bindings', async () => {
    const deps = launcherDeps(sourceReturning(undefined), recordingLogger());
    const bindings = await resolveImplementAgentBindings(deps, implementPair());
    expect(bindings.generator).toStrictEqual({});
    expect(bindings.evaluator).toStrictEqual({});
  });

  it('an evaluator-only binding resolves only the evaluator role — the generator role is untouched (AC3)', async () => {
    const found = definition();
    const deps = launcherDeps(sourceReturning(found), recordingLogger());
    const bindings = await resolveImplementAgentBindings(deps, implementPair({ evaluator: 'ralphctl-evaluator' }));

    expect(bindings.generator).toStrictEqual({});
    expect(bindings.evaluator.definition).toBe(found);
    expect(bindings.evaluator.section).toBeDefined();
  });

  it('a binding to a non-existent name resolves to an empty binding for that role', async () => {
    const logger = recordingLogger();
    const deps = launcherDeps(sourceReturning(undefined), logger);
    const bindings = await resolveImplementAgentBindings(deps, implementPair({ generator: 'ralphctl-missing' }));

    expect(bindings.generator).toStrictEqual({});
    expect(logger.warnings.some((w) => w.message.includes('ralphctl-missing'))).toBe(true);
  });
});
