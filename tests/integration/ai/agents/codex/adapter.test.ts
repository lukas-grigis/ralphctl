import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createCodexAgentDefinitionAdapter } from '@src/integration/ai/agents/codex/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-agents-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'implementer',
  description: 'Writes features, fixes bugs, adds tests.',
  content: 'You are an implementer.\n',
  ...overrides,
});

describe('createCodexAgentDefinitionAdapter — golden render', () => {
  it('writes the definition to <sessionDir>/.codex/agents/ralphctl-<name>.toml with the body under developer_instructions', async () => {
    const session = await makeSession();
    const adapter = createCodexAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ model: 'claude-sonnet-5', effort: 'high' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.codex/agents/ralphctl-implementer.toml'), 'utf-8');
    expect(written).toBe(
      [
        'name = "implementer"',
        'description = "Writes features, fixes bugs, adds tests."',
        'developer_instructions = "You are an implementer."',
        'model = "claude-sonnet-5"',
        'model_reasoning_effort = "high"',
        '',
      ].join('\n')
    );
  });

  it('escapes quotes and newlines inside the body via TOML basic-string escaping', async () => {
    const session = await makeSession();
    const adapter = createCodexAgentDefinitionAdapter();

    await adapter.install(session, [definition({ content: 'Line one.\nQuote: "hello"\n' })]);

    const written = await readFile(join(String(session), '.codex/agents/ralphctl-implementer.toml'), 'utf-8');
    expect(written).toContain('developer_instructions = "Line one.\\nQuote: \\"hello\\""');
  });

  it('omits optional model / model_reasoning_effort keys when absent', async () => {
    const session = await makeSession();
    const adapter = createCodexAgentDefinitionAdapter();

    await adapter.install(session, [definition()]);

    const written = await readFile(join(String(session), '.codex/agents/ralphctl-implementer.toml'), 'utf-8');
    expect(written).not.toContain('model');
  });

  it('describeConvention mentions .codex/agents/', () => {
    const adapter = createCodexAgentDefinitionAdapter();
    expect(adapter.describeConvention()).toContain('.codex/agents/');
  });
});
