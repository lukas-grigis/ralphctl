import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createClaudeAgentDefinitionAdapter } from '@src/integration/ai/agents/claude/adapter.ts';
import { installAgentDefinitionsLeaf } from '@src/application/flows/_shared/agents/install-agent-definitions.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'install-agent-definitions-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'ralphctl-evaluator',
  description: 'Reviews the generator turn.',
  content: 'You are an evaluator.\n',
  ...overrides,
});

describe('installAgentDefinitionsLeaf', () => {
  it('installs the correct native file for the role provider when a definition is bound', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();
    const leaf = installAgentDefinitionsLeaf<{ readonly cwd: AbsolutePath }>(
      { agentDefinitionAdapter: adapter },
      { definition: definition(), cwdPicker: (ctx) => ctx.cwd }
    );

    const result = await leaf.execute({ cwd: session });
    expect(result.ok).toBe(true);

    const written = await readFile(join(String(session), '.claude/agents/ralphctl-evaluator.md'), 'utf-8');
    expect(written).toContain('name: ralphctl-evaluator');
  });

  it('is a no-op when the role has no bound definition (definition undefined)', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();
    const leaf = installAgentDefinitionsLeaf<{ readonly cwd: AbsolutePath }>(
      { agentDefinitionAdapter: adapter },
      { definition: undefined, cwdPicker: (ctx) => ctx.cwd }
    );

    const result = await leaf.execute({ cwd: session });
    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.claude'))).toBe(false);
  });
});
