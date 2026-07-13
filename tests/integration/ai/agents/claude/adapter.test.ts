import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createClaudeAgentDefinitionAdapter } from '@src/integration/ai/agents/claude/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agents-'));
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

describe('createClaudeAgentDefinitionAdapter — golden render', () => {
  it('writes the definition to <sessionDir>/.claude/agents/ralphctl-<name>.md', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ model: 'claude-sonnet-5', effort: 'high' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.claude/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).toBe(
      [
        '---',
        'name: implementer',
        'description: Writes features, fixes bugs, adds tests.',
        'model: claude-sonnet-5',
        'effort: high',
        '---',
        '',
        'You are an implementer.',
        '',
      ].join('\n')
    );
  });

  it('omits optional model / effort frontmatter keys when absent', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();

    await adapter.install(session, [definition()]);

    const written = await readFile(join(String(session), '.claude/agents/ralphctl-implementer.md'), 'utf-8');
    expect(written).not.toContain('model:');
    expect(written).not.toContain('effort:');
  });

  it('describeConvention mentions .claude/agents/', () => {
    const adapter = createClaudeAgentDefinitionAdapter();
    expect(adapter.describeConvention()).toContain('.claude/agents/');
  });
});
