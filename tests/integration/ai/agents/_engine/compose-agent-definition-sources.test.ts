import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import type { AgentDefinitionSource } from '@src/integration/ai/agents/_engine/agent-definition-source.ts';
import { composeAgentDefinitionSources } from '@src/integration/ai/agents/_engine/compose-agent-definition-sources.ts';

const def = (name: string, description = `${name} guidance`): AgentDefinition => ({
  name,
  description,
  content: `# ${name}\nbody\n`,
});

const fakeStaticSource = (definitions: readonly AgentDefinition[]): AgentDefinitionSource => ({
  async list() {
    return Result.ok(definitions);
  },
  async getByName(name: string) {
    return Result.ok(definitions.find((d) => d.name === name));
  },
});

const fakeErrorSource = (error: StorageError): AgentDefinitionSource => ({
  async list() {
    return Result.error(error);
  },
  async getByName() {
    return Result.error(error);
  },
});

describe('composeAgentDefinitionSources', () => {
  it('unions definitions from every source', async () => {
    const bundled = fakeStaticSource([def('ralphctl-evaluator'), def('ralphctl-generator')]);
    const operator = fakeStaticSource([def('ralphctl-house-reviewer')]);
    const composed = composeAgentDefinitionSources(bundled, operator);

    const result = await composed.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((d) => d.name).sort()).toEqual([
      'ralphctl-evaluator',
      'ralphctl-generator',
      'ralphctl-house-reviewer',
    ]);
  });

  it('a later source wins a name collision (operator overrides bundled)', async () => {
    const bundled = fakeStaticSource([def('ralphctl-evaluator', 'bundled default')]);
    const operator = fakeStaticSource([def('ralphctl-evaluator', 'operator override')]);
    const composed = composeAgentDefinitionSources(bundled, operator);

    const result = await composed.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.description).toBe('operator override');
  });

  it('getByName resolves through the composed precedence', async () => {
    const bundled = fakeStaticSource([def('ralphctl-evaluator', 'bundled default')]);
    const operator = fakeStaticSource([def('ralphctl-evaluator', 'operator override')]);
    const composed = composeAgentDefinitionSources(bundled, operator);

    const result = await composed.getByName('ralphctl-evaluator');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.description).toBe('operator override');
  });

  it('getByName returns ok(undefined) for a name no source provides', async () => {
    const composed = composeAgentDefinitionSources(fakeStaticSource([def('ralphctl-evaluator')]));
    const result = await composed.getByName('ralphctl-unknown');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('short-circuits on the first source error, unmasked by a later source', async () => {
    const error = new StorageError({ subCode: 'io', message: 'boom' });
    const failing = fakeErrorSource(error);
    const healthy = fakeStaticSource([def('ralphctl-generator')]);
    const composed = composeAgentDefinitionSources(failing, healthy);

    const result = await composed.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('boom');
  });
});
