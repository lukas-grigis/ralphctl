import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createCopilotAgentDefinitionAdapter } from '@src/integration/ai/agents/copilot/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-agents-'));
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

describe('createCopilotAgentDefinitionAdapter — golden render', () => {
  it('writes the definition to <sessionDir>/.github/agents/ralphctl-<name>.agent.md', async () => {
    const session = await makeSession();
    const adapter = createCopilotAgentDefinitionAdapter();

    const result = await adapter.install(session, [definition({ model: 'claude-sonnet-5' })]);
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.github/agents/ralphctl-implementer.agent.md'), 'utf-8');
    expect(written).toBe(
      [
        '---',
        'description: Writes features, fixes bugs, adds tests.',
        'name: implementer',
        'model: claude-sonnet-5',
        '---',
        '',
        'You are an implementer.',
        '',
      ].join('\n')
    );
  });

  it('describeConvention mentions .github/agents/', () => {
    const adapter = createCopilotAgentDefinitionAdapter();
    expect(adapter.describeConvention()).toContain('.github/agents/');
  });
});

describe('createCopilotAgentDefinitionAdapter — 30000-char body size guard', () => {
  it('returns a StorageError and writes no file when the body exceeds 30000 chars', async () => {
    const session = await makeSession();
    const adapter = createCopilotAgentDefinitionAdapter();
    const oversized = definition({ content: 'x'.repeat(30001) });

    const result = await adapter.install(session, [oversized]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('schema-mismatch');
      expect(result.error.message).toContain('30000');
    }

    expect(existsSync(join(String(session), '.github/agents/ralphctl-implementer.agent.md'))).toBe(false);
    expect(existsSync(join(String(session), '.github'))).toBe(false);
  });

  it('accepts a body at exactly the 30000-char limit', async () => {
    const session = await makeSession();
    const adapter = createCopilotAgentDefinitionAdapter();
    const atLimit = definition({ content: 'x'.repeat(30000) });

    const result = await adapter.install(session, [atLimit]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.github/agents/ralphctl-implementer.agent.md'))).toBe(true);
  });
});
