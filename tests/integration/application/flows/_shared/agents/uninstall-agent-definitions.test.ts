import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { createClaudeAgentDefinitionAdapter } from '@src/integration/ai/agents/claude/adapter.ts';
import { installAgentDefinitionsLeaf } from '@src/application/flows/_shared/agents/install-agent-definitions.ts';
import { uninstallAgentDefinitionsLeaf } from '@src/application/flows/_shared/agents/uninstall-agent-definitions.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'uninstall-agent-definitions-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const definition: AgentDefinition = {
  name: 'ralphctl-evaluator',
  description: 'Reviews the generator turn.',
  content: 'You are an evaluator.\n',
};

describe('uninstallAgentDefinitionsLeaf', () => {
  it('removes the file the matching install leaf placed', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();
    const cwdPicker = (ctx: { readonly cwd: AbsolutePath }): AbsolutePath => ctx.cwd;

    const install = installAgentDefinitionsLeaf<{ readonly cwd: AbsolutePath }>(
      { agentDefinitionAdapter: adapter },
      { definition, cwdPicker }
    );
    await install.execute({ cwd: session });
    expect(existsSync(join(String(session), '.claude/agents/ralphctl-evaluator.md'))).toBe(true);

    const uninstall = uninstallAgentDefinitionsLeaf<{ readonly cwd: AbsolutePath }>(
      { agentDefinitionAdapter: adapter },
      { cwdPicker }
    );
    const result = await uninstall.execute({ cwd: session });

    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.claude/agents/ralphctl-evaluator.md'))).toBe(false);
  });

  it('is idempotent — uninstalling without a prior install is a no-op', async () => {
    const session = await makeSession();
    const adapter = createClaudeAgentDefinitionAdapter();
    const uninstall = uninstallAgentDefinitionsLeaf<{ readonly cwd: AbsolutePath }>(
      { agentDefinitionAdapter: adapter },
      { cwdPicker: (ctx) => ctx.cwd }
    );

    const result = await uninstall.execute({ cwd: session });
    expect(result.ok).toBe(true);
  });
});
